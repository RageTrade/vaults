// SPDX-License-Identifier: MIT

pragma solidity ^0.8.9;

import { IERC4626 } from 'contracts/interfaces/IERC4626.sol';
import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { IERC20Metadata } from '@openzeppelin/contracts/interfaces/IERC20Metadata.sol';

import { IGlpManager } from 'contracts/interfaces/gmx/IGlpManager.sol';
import { IVault as IGMXVault } from 'contracts/interfaces/gmx/IVault.sol';
import { ISGLPExtended } from 'contracts/interfaces/gmx/ISGLPExtended.sol';
import { IRewardRouterV2 } from 'contracts/interfaces/gmx/IRewardRouterV2.sol';
import { IGMXBatchingManager } from 'contracts/interfaces/gmx/IGMXBatchingManager.sol';
import { FullMath } from '@uniswap/v3-core-0.8-support/contracts/libraries/FullMath.sol';

import { RageERC4626 } from '../../base/RageERC4626.sol';
import { OwnableUpgradeable } from '@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol';

contract GlpStakingManager is RageERC4626, OwnableUpgradeable {
    using FullMath for uint256;

    error GYS_INVALID_SETTER_VALUES();
    error GYS_INVALID_SET_VAULT();
    error GYS_CALLER_NOT_VAULT();

    event FeesWithdrawn(uint256 vaule);
    event GmxParamsUpdated(uint256 newFee, address batchingManager);
    event VaultUpdated(address vaultAddress, bool isVault);

    event TokenWithdrawn(address token, uint256 shares, address receiver);
    event TokenRedeemded(address token, uint256 _sGLPQuantity, address receiver);

    /* solhint-disable var-name-mixedcase */
    uint256 public constant MAX_BPS = 10_000;
    uint256 public constant USDG_DECIMALS = 18;
    uint256 public constant WETH_DECIMALS = 18;
    uint256 public constant PRICE_PRECISION = 10**30;

    /* solhint-disable var-name-mixedcase */
    uint256 public FEE = 1000;

    uint256 public protocolFee;
    uint256 public wethThreshold;
    uint256 public slippageThreshold;

    IERC20 private weth;
    IERC20 private fsGlp;
    IERC20 private usdc;

    IGMXVault private gmxVault;
    IGlpManager private glpManager;
    IRewardRouterV2 private rewardRouter;
    IGMXBatchingManager private batchingManager;

    mapping(address => bool) public isVault;

    struct GlpStakingManagerInitParams {
        RageERC4626InitParams rageErc4626InitParams;
        IERC20 weth;
        IERC20 usdc;
        IGlpManager glpManager;
        IRewardRouterV2 rewardRouter;
    }

    function initialize(GlpStakingManagerInitParams memory glpStakingManagerInitParams) external initializer {
        __Ownable_init();
        __RageERC4626_init(glpStakingManagerInitParams.rageErc4626InitParams);
        __GlpStakingManager_init(glpStakingManagerInitParams);
    }

    /* solhint-disable-next-line func-name-mixedcase */
    function __GlpStakingManager_init(GlpStakingManagerInitParams memory params) internal onlyInitializing {
        weth = params.weth;
        usdc = params.usdc;
        glpManager = params.glpManager;
        rewardRouter = params.rewardRouter;

        fsGlp = IERC20(ISGLPExtended(address(asset)).stakedGlpTracker());
        gmxVault = IGMXVault(glpManager.vault());
    }

    function updateGMXParams(
        uint256 _feeBps,
        uint256 _wethThreshold,
        uint256 _slippageThreshold,
        address _batchingManager
    ) external onlyOwner {
        if (_feeBps < MAX_BPS && _slippageThreshold < MAX_BPS && _batchingManager != address(0)) {
            FEE = _feeBps;
            wethThreshold = _wethThreshold;
            slippageThreshold = _slippageThreshold;
            batchingManager = IGMXBatchingManager(_batchingManager);
        } else revert GYS_INVALID_SETTER_VALUES();

        // TODO: update event
        emit GmxParamsUpdated(_feeBps, _batchingManager);
    }

    function setVault(address vaultAddress, bool _isVault) external onlyOwner {
        if (isVault[vaultAddress] != _isVault) {
            isVault[vaultAddress] = _isVault;
        } else revert GYS_INVALID_SET_VAULT();

        emit VaultUpdated(vaultAddress, _isVault);
    }

    /// @notice grants one time max allowance to various third parties
    function grantAllowances() public onlyOwner {
        asset.approve(address(glpManager), type(uint256).max);
        asset.approve(address(rewardRouter), type(uint256).max);

        weth.approve(address(glpManager), type(uint256).max);
        weth.approve(address(rewardRouter), type(uint256).max);
        weth.approve(address(batchingManager), type(uint256).max);

        usdc.approve(address(glpManager), type(uint256).max);
        usdc.approve(address(rewardRouter), type(uint256).max);
        usdc.approve(address(batchingManager), type(uint256).max);
    }

    /// @notice withdraw accumulated CRV fees
    function withdrawFees() external onlyOwner {
        uint256 amount = protocolFee;
        protocolFee = 0;
        weth.transfer(msg.sender, amount);
        emit FeesWithdrawn(amount);
    }

    /// @notice claims the accumulated CRV rewards from the gauge, sells CRV rewards for LP tokens and stakes LP tokens
    function _harvestFees() internal {
        rewardRouter.handleRewards(false, false, true, true, true, true, false);
        uint256 wethHarvested = weth.balanceOf(address(this)) - protocolFee;
        if (wethHarvested > wethThreshold) {
            uint256 protocolFeeHarvested = (wethHarvested * FEE) / MAX_BPS;
            protocolFee += protocolFeeHarvested;

            uint256 wethToCompound = wethHarvested - protocolFeeHarvested;

            uint256 price = gmxVault.getMinPrice(address(weth));
            uint256 usdgAmount = wethToCompound.mulDiv(
                price * (MAX_BPS - slippageThreshold),
                PRICE_PRECISION * MAX_BPS
            );

            usdgAmount = usdgAmount.mulDiv(10**USDG_DECIMALS, 10**WETH_DECIMALS);

            batchingManager.depositToken(address(weth), wethToCompound, usdgAmount);
        }
    }

    /// @dev also check if the msg.sender is vault
    function _beforeShareAllocation() internal override {
        if (!isVault[_msgSender()]) revert GYS_CALLER_NOT_VAULT();
        _harvestFees();
    }

    function beforeWithdrawClosePosition(int256) internal override {
        // NO OP
    }

    function _simulateBeforeWithdraw(uint256 assets)
        internal
        pure
        override
        returns (uint256 adjustedAssets, int256 tokensToTrade)
    {
        return (assets, 0);
    }

    function totalAssets() public view override returns (uint256) {
        return fsGlp.balanceOf(address(this)) + batchingManager.stakingManagerGlpBalance();
    }

    /// @dev only works for usdc and weth because approval is only given for those tokens
    function depositToken(address token, uint256 amount) external returns (uint256 shares) {
        _beforeShareAllocation();

        IERC20(token).transferFrom(_msgSender(), address(this), amount);

        uint256 price = gmxVault.getMinPrice(token);
        uint256 usdgAmount = amount.mulDiv(price * (MAX_BPS - slippageThreshold), PRICE_PRECISION * MAX_BPS);

        usdgAmount = usdgAmount.mulDiv(10**USDG_DECIMALS, 10**IERC20Metadata(token).decimals());

        uint256 assets = batchingManager.depositToken(token, amount, usdgAmount);

        require((shares = previewDeposit(assets)) != 0, 'ZERO_SHARES');

        // // Need to transfer before minting or ERC777s could reenter.
        // asset.safeTransferFrom(msg.sender, address(this), assets);

        _mint(_msgSender(), shares);

        emit Deposit(msg.sender, _msgSender(), assets, shares);

        afterDeposit(assets, shares);
    }
}
