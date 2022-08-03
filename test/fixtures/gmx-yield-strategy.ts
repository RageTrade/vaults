import { deployments } from 'hardhat';
import { ERC20 } from '../../typechain-types/artifacts/@openzeppelin/contracts/token/ERC20/ERC20';
import { GMXYieldStrategy__factory } from '../../typechain-types';

import { parseTokenAmount } from '@ragetrade/sdk';

import addresses, { GMX_ECOSYSTEM_ADDRESSES } from './addresses';
import { eightyTwentyRangeStrategyFixture } from './eighty-twenty-range-strategy-vault';
import { getErc20 } from '../utils/erc20';
import { parseEther } from 'ethers/lib/utils';

export const gmxYieldStrategyFixture = deployments.createFixture(async hre => {
  const {
    clearingHouse,
    collateralToken,
    settlementToken,
    settlementTokenTreasury,
    ethPoolId,
    swapSimulator,
    clearingHouseLens,
  } = await eightyTwentyRangeStrategyFixture();

  const gmx = await getErc20(GMX_ECOSYSTEM_ADDRESSES.GMX);
  const glp = await getErc20(GMX_ECOSYSTEM_ADDRESSES.GLP);
  const sGLP = await getErc20(GMX_ECOSYSTEM_ADDRESSES.StakedGlp);
  const sGMX = await getErc20(GMX_ECOSYSTEM_ADDRESSES.StakedGmx);
  const fsGLP = await getErc20(GMX_ECOSYSTEM_ADDRESSES.fsGLP);

  const swapManager = await (await hre.ethers.getContractFactory('SwapManager')).deploy();
  const logic = await (
    await hre.ethers.getContractFactory('Logic', {
      libraries: {
        ['contracts/libraries/SwapManager.sol:SwapManager']: swapManager.address,
      },
    })
  ).deploy();

  const [signer] = await hre.ethers.getSigners();
  let gmxYieldStrategy = await new GMXYieldStrategy__factory(
    {
      ['contracts/libraries/Logic.sol:Logic']: logic.address,
    },
    signer,
  ).deploy();

  await gmxYieldStrategy.initialize({
    eightyTwentyRangeStrategyVaultInitParams: {
      baseVaultInitParams: {
        rageErc4626InitParams: {
          asset: sGLP.address,
          name: 'Gmx Vault Shares',
          symbol: 'GVS',
        },
        ethPoolId,
        swapSimulator: swapSimulator.address,
        rageClearingHouse: clearingHouse.address,
        clearingHouseLens: clearingHouseLens.address,
        rageCollateralToken: collateralToken.address,
        rageSettlementToken: settlementToken.address,
      },
      closePositionSlippageSqrtToleranceBps: 0,
      resetPositionThresholdBps: 0,
      minNotionalPositionToCloseThreshold: 0,
    },
    glp: GMX_ECOSYSTEM_ADDRESSES.GLP,
    weth: addresses.WETH,
    glpManager: GMX_ECOSYSTEM_ADDRESSES.GlpManager,
    rewardRouter: GMX_ECOSYSTEM_ADDRESSES.RewardRouter,
  });

  const glpStakingManagerFactory = await hre.ethers.getContractFactory('GlpStakingManager');

  const glpStakingManager = await glpStakingManagerFactory.deploy();

  glpStakingManager.initialize({
    rageErc4626InitParams: {
      asset: sGLP.address,
      name: 'TriCrypto Shares',
      symbol: 'TCS',
    },
    weth: addresses.WETH,
    usdc: addresses.USDC,
    glpManager: GMX_ECOSYSTEM_ADDRESSES.GlpManager,
    rewardRouter: GMX_ECOSYSTEM_ADDRESSES.RewardRouter,
  });

  const gmxBatchingManagerFactory = await hre.ethers.getContractFactory('GMXBatchingManager');

  const gmxBatchingManager = await gmxBatchingManagerFactory.deploy();

  // console.log({gmxBatchingManagerAddress,actualAddress:gmxBatchingManager.address});

  await gmxBatchingManager.initialize(
    GMX_ECOSYSTEM_ADDRESSES.StakedGlp,
    GMX_ECOSYSTEM_ADDRESSES.RewardRouter,
    GMX_ECOSYSTEM_ADDRESSES.GlpManager,
    glpStakingManager.address,
    signer.address,
    10,
  );

  await glpStakingManager.updateGMXParams(100, 0, 500, gmxBatchingManager.address);
  await glpStakingManager.setVault(gmxYieldStrategy.address, true);
  await gmxYieldStrategy.updateBaseParams(parseEther('100'), signer.address, 0, 0);
  await gmxYieldStrategy.updateGMXParams(100, 10, 0, gmxBatchingManager.address, glpStakingManager.address);

  await gmxBatchingManager.addVault(gmxYieldStrategy.address);
  await gmxBatchingManager.grantAllowances(gmxYieldStrategy.address);

  await glpStakingManager.grantAllowances();
  await gmxYieldStrategy.grantAllowances();

  await collateralToken.grantRole(await collateralToken.MINTER_ROLE(), gmxYieldStrategy.address);

  await settlementToken
    .connect(settlementTokenTreasury)
    .approve(gmxYieldStrategy.address, parseTokenAmount(10n ** 10n, 18));
  await collateralToken
    .connect(settlementTokenTreasury)
    .approve(clearingHouse.address, parseTokenAmount(10n ** 10n, 18));
  await collateralToken.approve(clearingHouse.address, parseTokenAmount(10n ** 10n, 18));
  await settlementToken.approve(clearingHouse.address, parseTokenAmount(10n ** 5n, 6));

  return {
    gmx,
    glp,
    sGLP,
    sGMX,
    fsGLP,
    gmxYieldStrategy,
    clearingHouse,
    collateralToken,
    settlementToken,
    settlementTokenTreasury,
    ethPoolId,
    swapSimulator,
    clearingHouseLens,
    gmxBatchingManager,
    glpStakingManager,
  };
});
