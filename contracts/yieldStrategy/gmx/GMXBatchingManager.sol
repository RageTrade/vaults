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

    struct VaultBatchingState {
        uint256 currentRound;
        uint256 roundGlpBalance;
        mapping(address => UserDeposit) userDeposits;
        mapping(uint256 => RoundDeposit) roundDeposits;
    }

    IERC4626[10] public vaults;
    uint8 vaultCount;
    mapping(IERC4626 => VaultBatchingState) public vaultBatchingState;
    address public stakingManager; // used for depositing harvested rewards
    uint256 public stakingManagerGlpBalance;
    IRewardRouterV2 public rewardRouter;
    IGlpManager public glpManager;

    IERC20 public sGlp;
    address public keeper;

    error InvalidVault(address vault);

    modifier onlyStakingManager() {
        if (_msgSender() != stakingManager) revert CallerNotStakingManager();
        _;
    }

    modifier onlyKeeper() {
        if (_msgSender() != keeper) revert CallerNotKeeper();
        _;
    }

    function initialize(
        IERC20 _sGlp,
        IRewardRouterV2 _rewardRouter,
        IGlpManager _glpManager,
        address _stakingManager,
        address _keeper
    ) external initializer {
        __Ownable_init();
        __Pausable_init();
        __GMXBatchingManager_init(_sGlp, _rewardRouter, _glpManager, _stakingManager, _keeper);
    }

    function __GMXBatchingManager_init(
        IERC20 _sGlp,
        IRewardRouterV2 _rewardRouter,
        IGlpManager _glpManager,
        address _stakingManager,
        address _keeper
    ) internal onlyInitializing {
        sGlp = _sGlp;
        rewardRouter = _rewardRouter;
        glpManager = _glpManager;

        stakingManager = _stakingManager;

        keeper = _keeper;
        emit KeeperUpdated(_keeper);
    }

    function grantAllowances(IERC4626 gmxVault) external onlyOwner {
        _ensureVaultIsValid(gmxVault);
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
        uint256 minUSDG
    ) external whenNotPaused onlyStakingManager returns (uint256 glpStaked) {
        if (token == address(0)) revert InvalidInput(0x30);
        if (amount == 0) revert InvalidInput(0x31);

        IERC20(token).transferFrom(_msgSender(), address(this), amount);

        // Convert tokens to glp
        glpStaked = _stakeGlp(token, amount, minUSDG);
        stakingManagerGlpBalance += glpStaked.toUint128();

        emit DepositToken(0, token, _msgSender(), amount, glpStaked);
    }

    function depositToken(
        IERC4626 gmxVault,
        address token,
        uint256 amount,
        uint256 minUSDG,
        address receiver
    ) external whenNotPaused returns (uint256 glpStaked) {
        if (token == address(0)) revert InvalidInput(0x20);
        if (amount == 0) revert InvalidInput(0x21);
        if (receiver == address(0)) revert InvalidInput(0x22);

        // Transfer Tokens To Manager
        IERC20(token).transferFrom(_msgSender(), address(this), amount);

        VaultBatchingState storage state = vaultBatchingState[gmxVault];
        UserDeposit storage userDeposit = state.userDeposits[receiver];
        uint128 userGlpBalance = userDeposit.glpBalance;

        //Convert previous round glp balance into unredeemed shares
        uint256 userDepositRound = userDeposit.round;
        if (userDepositRound < state.currentRound && userGlpBalance > 0) {
            RoundDeposit storage roundDeposit = state.roundDeposits[userDepositRound];
            userDeposit.unclaimedShares += userDeposit
                .glpBalance
                .mulDiv(roundDeposit.totalShares, roundDeposit.totalGlp)
                .toUint128();
            userGlpBalance = 0;
        }

        // Convert tokens to glp
        glpStaked = _stakeGlp(token, amount, minUSDG);

        //Update round and glp balance for current round
        userDeposit.round = state.currentRound;
        userDeposit.glpBalance = userGlpBalance + glpStaked.toUint128();
        state.roundGlpBalance += glpStaked.toUint128();

        emit DepositToken(state.currentRound, token, receiver, amount, glpStaked);
    }

    function executeBatchDeposit() external {
        // Transfer vault glp directly

        // if (stakingManagerGlpBalance == 0 && state.roundGlpBalance == 0) revert ZeroBalance();

        //Needs to be called only for StakingManager
        if (stakingManagerGlpBalance > 0) {
            uint256 glpToTransfer = stakingManagerGlpBalance;
            stakingManagerGlpBalance = 0;
            sGlp.transfer(address(stakingManager), glpToTransfer);
            emit VaultDeposit(glpToTransfer);
        }

        for (uint256 i = 0; i < vaults.length; i++) {
            IERC4626 vault = vaults[i];
            if (address(vault) == address(0)) break;

            _executeVaultUserBatchDeposit(vault);
        }
        // If the deposit is paused then unpause on execute batch deposit
        if (paused()) {
            _unpause();
        }
    }

    function _executeVaultUserBatchDeposit(IERC4626 vault) internal {
        VaultBatchingState storage state = vaultBatchingState[vault];

        // Transfer user glp through deposit
        if (state.roundGlpBalance > 0) {
            uint256 totalShares = vault.deposit(state.roundGlpBalance, address(this));

            // Update round data
            state.roundDeposits[state.currentRound] = RoundDeposit(
                state.roundGlpBalance.toUint128(),
                totalShares.toUint128()
            );

            emit BatchDeposit(state.currentRound, state.roundGlpBalance, totalShares);

            state.roundGlpBalance = 0;
            ++state.currentRound;
        }
    }

    function glpBalance(address account) external view returns (uint256 balance) {
        for (uint256 i; i < vaults.length; i++) {
            balance += glpBalancePerVault(vaults[i], account);
        }
    }

    function glpBalancePerVault(IERC4626 gmxVault, address account) public view returns (uint256 balance) {
        balance = vaultBatchingState[gmxVault].userDeposits[account].glpBalance;
    }

    function unclaimedShares(address account) external view returns (uint256 shares) {
        for (uint256 i; i < vaults.length; i++) {
            shares += unclaimedSharesPerVault(vaults[i], account);
        }
    }

    function unclaimedSharesPerVault(IERC4626 gmxVault, address account) public view returns (uint256 shares) {
        shares = vaultBatchingState[gmxVault].userDeposits[account].unclaimedShares;
    }

    function claim(
        IERC4626 gmxVault,
        address receiver,
        uint256 amount
    ) external {
        if (receiver == address(0)) revert InvalidInput(0x10);
        if (amount == 0) revert InvalidInput(0x11);

        VaultBatchingState storage state = vaultBatchingState[gmxVault];
        UserDeposit storage userDeposit = state.userDeposits[_msgSender()];
        uint128 userUnclaimedShares = userDeposit.unclaimedShares;
        uint128 userGlpBalance = userDeposit.glpBalance;
        {
            //Convert previous round glp balance into unredeemed shares
            uint256 userDepositRound = userDeposit.round;
            if (userDepositRound < state.currentRound && userGlpBalance > 0) {
                RoundDeposit storage roundDeposit = state.roundDeposits[userDepositRound];
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

    function currentRound(IERC4626 vault) external view returns (uint256) {
        return vaultBatchingState[vault].currentRound;
    }

    function roundGlpBalance(IERC4626 vault) external view returns (uint256) {
        return vaultBatchingState[vault].roundGlpBalance;
    }

    function userDeposits(IERC4626 vault, address account) external view returns (UserDeposit memory) {
        return vaultBatchingState[vault].userDeposits[account];
    }

    function roundDeposits(IERC4626 vault, uint256 round) external view returns (RoundDeposit memory) {
        return vaultBatchingState[vault].roundDeposits[round];
    }

    function isVaultValid(IERC4626 vault) external view returns (bool) {
        return _isVaultValid(vault);
    }

    function _stakeGlp(
        address token,
        uint256 amount,
        uint256 minUSDG
    ) internal returns (uint256 glpStaked) {
        // Convert tokens to glp and stake glp to obtain sGLP
        IERC20(token).approve(address(glpManager), amount);
        glpStaked = rewardRouter.mintAndStakeGlp(token, amount, minUSDG, 0);
    }

    function addVault(IERC4626 vault) external onlyOwner {
        if (vaultCount == vaults.length) revert VaultsLimitExceeded();
        if (vaultBatchingState[vault].currentRound != 0) revert VaultAlreadyAdded();
        vaultBatchingState[vault].currentRound = 1;
        vaults[vaultCount] = vault;
        ++vaultCount;
    }

    function _ensureVaultIsValid(IERC4626 vault) internal view {
        if (!_isVaultValid(vault)) revert InvalidVault(address(vault));
    }

    function _isVaultValid(IERC4626 vault) internal view returns (bool) {
        return vaultBatchingState[vault].currentRound != 0;
    }
}
