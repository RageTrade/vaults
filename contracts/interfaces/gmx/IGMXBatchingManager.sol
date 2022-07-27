// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

interface IGMXBatchingManager {
    error InvalidSetDepositPaused(bool currentValue);
    error InsufficientShares(uint256 balance);
    error InvalidInput(uint256 errorCode);
    error CallerNotKeeper();
    error ZeroBalance();

    event DepositToken(uint256 round, address token, address receiver, uint256 amount, uint256 glpStaked);
    event VaultDeposit(uint256 vaultGlpAmount);
    event BatchDeposit(uint256 round, uint256 userGlpAmount, uint256 userShareAmount);
    event SharesClaimed(address from, address receiver, uint256 claimAmount);
    event KeeperUpdated(address newKeeper);

    struct UserDeposit {
        uint256 round;
        uint128 glpBalance;
        uint128 unclaimedShares;
    }
    struct RoundDeposit {
        uint128 totalGlp;
        uint128 totalShares;
    }

    function depositToken(
        address token,
        uint256 amount,
        address receiver
    ) external returns (uint256 glpStaked);

    function executeBatchDeposit() external;

    function glpBalance(address account) external view returns (uint256 balance);

    function unclaimedShares(address account) external view returns (uint256 shares);

    function claim(address receiver, uint256 amount) external;
}
