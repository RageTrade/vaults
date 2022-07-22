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

    struct UserDeposit {
        uint256 round;
        uint128 glpBalance;
        uint128 unclaimedShares;
    }
    struct RoundDeposit {
        uint128 totalGlp;
        uint128 totalShares;
    }
    mapping(address => UserDeposit) private userDeposits;
    mapping(uint256 => RoundDeposit) public roundDeposits;

    uint256 public currentRound;
    uint256 public roundGlpBalance;

    IRewardRouterV2 public rewardRouter;
    IERC4626 public gmxVault;
    IERC20 public sGlp;

    function initialize(
        IERC20 _sGlp,
        IRewardRouterV2 _rewardRouter,
        IERC4626 _gmxVault
    ) external initializer {
        __Ownable_init();
        __Pausable_init();
        __GMXBatchingManager_init(_sGlp, _rewardRouter, _gmxVault);
    }

    function __GMXBatchingManager_init(
        IERC20 _sGlp,
        IRewardRouterV2 _rewardRouter,
        IERC4626 _gmxVault
    ) internal onlyInitializing {
        sGlp = _sGlp;
        rewardRouter = _rewardRouter;
        gmxVault = _gmxVault;
        currentRound = 1;
    }

    function pauseDeposit() external onlyOwner {
        _pause();
    }

    function unpauseDeposit() external onlyOwner {
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
            if (userDepositRound < currentRound) {
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
        emit DepositToken(token, receiver, amount, glpStaked);
    }

    function _stakeGlp(address token, uint256 amount) internal returns (uint256 glpStaked) {
        // Convert tokens to glp
        //USDG has 18 decimals and usdc has 6 decimals => 18-6 = 12
        IERC20(token).transferFrom(_msgSender(), address(this), amount);
        glpStaked = rewardRouter.mintAndStakeGlp(token, amount, amount.mulDiv(95 * 10**12, 100), 0);
    }

    function executeBatchDeposit() external {
        // Transfer vault glp directly
        UserDeposit storage vaultDeposit = userDeposits[address(gmxVault)];

        uint256 vaultGlpBalance = vaultDeposit.glpBalance;

        vaultDeposit.glpBalance = 0;

        sGlp.transfer(address(gmxVault), vaultGlpBalance);

        // Transfer user glp through deposit
        uint256 totalShares = gmxVault.deposit(roundGlpBalance, address(this));

        // Update round data
        roundDeposits[currentRound] = RoundDeposit(roundGlpBalance.toUint128(), totalShares.toUint128());

        emit BatchDeposit(roundGlpBalance, totalShares, vaultGlpBalance);

        roundGlpBalance = 0;
        ++currentRound;
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
        {
            //Convert previous round glp balance into unredeemed shares
            uint256 userDepositRound = userDeposit.round;
            if (userDepositRound < currentRound) {
                RoundDeposit storage roundDeposit = roundDeposits[userDepositRound];
                userUnclaimedShares += userDeposit
                    .glpBalance
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
}
