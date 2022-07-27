// SPDX-License-Identifier: MIT

pragma solidity ^0.8.9;

import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { IERC20Metadata } from '@openzeppelin/contracts/interfaces/IERC20Metadata.sol';

import { OwnableUpgradeable } from '@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol';
import { FullMath } from '@uniswap/v3-core-0.8-support/contracts/libraries/FullMath.sol';
import { SafeCast } from '../../libraries/SafeCast.sol';

import { IGlpManager } from 'contracts/interfaces/gmx/IGlpManager.sol';
import { IRewardTracker } from 'contracts/interfaces/gmx/IRewardTracker.sol';
import { IRewardRouterV2 } from 'contracts/interfaces/gmx/IRewardRouterV2.sol';
import { IGMXBatchingManager } from 'contracts/interfaces/gmx/IGMXBatchingManager.sol';
import { IERC4626 } from 'contracts/interfaces/IERC4626.sol';
import { PausableUpgradeable } from '@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol';

contract GMXBatchingManager is IGMXBatchingManager, OwnableUpgradeable, PausableUpgradeable {
    using FullMath for uint256;
    using FullMath for uint128;
    using SafeCast for uint256;

    mapping(address => UserDeposit) public userDeposits;
    mapping(uint256 => RoundDeposit) public roundDeposits;

    modifier onlyKeeper() {
        if (_msgSender() != keeper) revert CallerNotKeeper();
        _;
    }
    uint256 public currentRound;
    uint256 public roundGlpBalance;

    IRewardRouterV2 public rewardRouter;
    IGlpManager public glpManager;

    IERC4626 public gmxVault;
    IERC20 public sGlp;
    address public keeper;

    function initialize(
        IERC20 _sGlp,
        IRewardRouterV2 _rewardRouter,
        IGlpManager _glpManager,
        IERC4626 _gmxVault,
        address _keeper
    ) external initializer {
        __Ownable_init();
        __Pausable_init();
        __GMXBatchingManager_init(_sGlp, _rewardRouter, _glpManager, _gmxVault, _keeper);
    }

    function __GMXBatchingManager_init(
        IERC20 _sGlp,
        IRewardRouterV2 _rewardRouter,
        IGlpManager _glpManager,
        IERC4626 _gmxVault,
        address _keeper
    ) internal onlyInitializing {
        sGlp = _sGlp;
        rewardRouter = _rewardRouter;
        glpManager = _glpManager;
        gmxVault = _gmxVault;
        keeper = _keeper;
        currentRound = 1;

        emit KeeperUpdated(_keeper);
    }

    function grantAllowances() external onlyOwner {
        sGlp.approve(address(rewardRouter), type(uint256).max);
        sGlp.approve(address(gmxVault), type(uint256).max);
    }

    function setKeeper(address _keeper) external onlyOwner {
        keeper = _keeper;
        emit KeeperUpdated(_keeper);
    }

    function pauseDeposit() external onlyKeeper {
        _pause();
    }

    function unpauseDeposit() external onlyKeeper {
        _unpause();
    }

    function depositToken(
        address token,
        uint256 amount,
        address receiver
    ) external whenNotPaused returns (uint256 glpStaked) {
        if (token == address(0)) revert InvalidInput(0x20);
        if (amount == 0) revert InvalidInput(0x21);
        if (receiver == address(0)) revert InvalidInput(0x22);

        // Transfer Tokens To Manager
        IERC20(token).transferFrom(_msgSender(), address(this), amount);

        UserDeposit storage userDeposit = userDeposits[receiver];
        uint128 userGlpBalance = userDeposit.glpBalance;
        if (receiver == address(gmxVault)) {
            // Convert tokens to glp
            glpStaked = _stakeGlp(token, amount);
            userDeposit.glpBalance = userGlpBalance + glpStaked.toUint128();
        } else {
            //Convert previous round glp balance into unredeemed shares
            uint256 userDepositRound = userDeposit.round;
            if (userDepositRound < currentRound && userGlpBalance > 0) {
                RoundDeposit storage roundDeposit = roundDeposits[userDepositRound];
                userDeposit.unclaimedShares += userDeposit
                    .glpBalance
                    .mulDiv(roundDeposit.totalShares, roundDeposit.totalGlp)
                    .toUint128();
                userGlpBalance = 0;
            }

            // Convert tokens to glp
            glpStaked = _stakeGlp(token, amount);

            //Update round and glp balance for current round
            userDeposit.round = currentRound;
            userDeposit.glpBalance = userGlpBalance + glpStaked.toUint128();
            roundGlpBalance += glpStaked.toUint128();
        }
        emit DepositToken(currentRound, token, receiver, amount, glpStaked);
    }

    function executeBatchDeposit() external {
        // Transfer vault glp directly
        UserDeposit storage vaultDeposit = userDeposits[address(gmxVault)];
        uint256 vaultGlpBalance = vaultDeposit.glpBalance;

        if (vaultGlpBalance == 0 && roundGlpBalance == 0) revert ZeroBalance();

        if (vaultGlpBalance > 0) {
            vaultDeposit.glpBalance = 0;
            sGlp.transfer(address(gmxVault), vaultGlpBalance);
            emit VaultDeposit(vaultGlpBalance);
        }

        // Transfer user glp through deposit
        if (roundGlpBalance > 0) {
            uint256 totalShares = gmxVault.deposit(roundGlpBalance, address(this));

            // Update round data
            roundDeposits[currentRound] = RoundDeposit(roundGlpBalance.toUint128(), totalShares.toUint128());

            emit BatchDeposit(currentRound, roundGlpBalance, totalShares);

            roundGlpBalance = 0;
            ++currentRound;
        }
        // If the deposit is paused then unpause on execute batch deposit
        if (paused()) {
            _unpause();
        }
    }

    function glpBalance(address account) external view returns (uint256 balance) {
        balance = userDeposits[account].glpBalance;
    }

    function unclaimedShares(address account) external view returns (uint256 shares) {
        shares = userDeposits[account].unclaimedShares;
    }

    function claim(address receiver, uint256 amount) external {
        if (receiver == address(0)) revert InvalidInput(0x10);
        if (amount == 0) revert InvalidInput(0x11);

        UserDeposit storage userDeposit = userDeposits[_msgSender()];
        uint128 userUnclaimedShares = userDeposit.unclaimedShares;
        uint128 userGlpBalance = userDeposit.glpBalance;
        {
            //Convert previous round glp balance into unredeemed shares
            uint256 userDepositRound = userDeposit.round;
            if (userDepositRound < currentRound && userGlpBalance > 0) {
                RoundDeposit storage roundDeposit = roundDeposits[userDepositRound];
                userUnclaimedShares += userGlpBalance
                    .mulDiv(roundDeposit.totalShares, roundDeposit.totalGlp)
                    .toUint128();
                userDeposit.glpBalance = 0;
            }
        }
        if (userUnclaimedShares < amount.toUint128()) revert InsufficientShares(userUnclaimedShares);
        userDeposit.unclaimedShares = userUnclaimedShares - amount.toUint128();
        IERC20(gmxVault).transfer(receiver, amount);

        emit SharesClaimed(_msgSender(), receiver, amount);
    }

    function _stakeGlp(address token, uint256 amount) internal returns (uint256 glpStaked) {
        // Convert tokens to glp
        //USDG has 18 decimals and usdc has 6 decimals => 18-6 = 12
        IERC20(token).approve(address(glpManager), amount);
        glpStaked = rewardRouter.mintAndStakeGlp(token, amount, amount.mulDiv(95 * 10**12, 100), 0);
    }
}
