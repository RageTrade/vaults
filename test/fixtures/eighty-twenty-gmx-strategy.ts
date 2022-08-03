import { deployments, ethers } from 'hardhat';
import { GMXYieldStrategy__factory } from '../../typechain-types';
import { ERC20 } from '../../typechain-types/artifacts/@openzeppelin/contracts/token/ERC20/ERC20';

import { parseTokenAmount, truncate } from '@ragetrade/sdk';

import { unlockWhales } from '../utils/curve-helper';
import { generateErc20Balance, getErc20 } from '../utils/erc20';
import { updateSettlementTokenMargin } from '../utils/rage-helpers';
import addresses, { GMX_ECOSYSTEM_ADDRESSES } from './addresses';
import { rageTradeFixture } from './ragetrade-core';

export const gmxYieldStrategyFixture = deployments.createFixture(async hre => {
  const { clearingHouse, settlementToken, pool0 } = await rageTradeFixture();

  await unlockWhales();
  const tokenFactory = await hre.ethers.getContractFactory('ERC20PresetMinterPauser');
  const collateralToken = await tokenFactory.deploy('Collateral Token', 'CT');

  const gmx = await getErc20(GMX_ECOSYSTEM_ADDRESSES.GMX);
  const glp = await getErc20(GMX_ECOSYSTEM_ADDRESSES.GLP);
  const sGLP = await getErc20(GMX_ECOSYSTEM_ADDRESSES.StakedGlp);
  const sGMX = await getErc20(GMX_ECOSYSTEM_ADDRESSES.StakedGmx);
  const fsGLP = await getErc20(GMX_ECOSYSTEM_ADDRESSES.fsGLP);

  const ethPoolId = truncate(pool0.vToken.address);

  const [admin, user1, user2, trader0] = await hre.ethers.getSigners();

  const closePositionSlippageSqrtToleranceBps = 500; //5%
  const resetPositionThresholdBps = 2000; //20%
  const minNotionalPositionToCloseThreshold = parseTokenAmount(10, 6);

  const collateralTokenOracle = await (await hre.ethers.getContractFactory('OracleMock')).deploy();

  await clearingHouse.updateCollateralSettings(collateralToken.address, {
    oracle: collateralTokenOracle.address,
    twapDuration: 300,
    isAllowedForDeposit: true,
  });

  const usdc = (await hre.ethers.getContractAt(
    '@openzeppelin/contracts/token/ERC20/ERC20.sol:ERC20',
    addresses.USDC,
  )) as ERC20;

  // await stealFunds(
  //   settlementToken.address,
  //   await settlementToken.decimals(),
  //   admin.address,
  //   10n ** 7n,
  //   addresses.USDC_WHALE,
  // );
  await generateErc20Balance(usdc, 10n ** 15n, admin.address);

  await clearingHouse.createAccount();
  const adminAccountNo = (await clearingHouse.numAccounts()).sub(1);

  await clearingHouse.connect(trader0).createAccount();
  const trader0AccountNo = (await clearingHouse.numAccounts()).sub(1);

  // await stealFunds(
  //   settlementToken.address,
  //   await settlementToken.decimals(),
  //   trader0.address,
  //   10n ** 7n,
  //   addresses.USDC_WHALE,
  // );
  await generateErc20Balance(usdc, 10n ** 15n, trader0.address);

  await updateSettlementTokenMargin(
    clearingHouse,
    settlementToken,
    trader0,
    trader0AccountNo,
    parseTokenAmount(10n ** 7n, 6),
  );

  await settlementToken.approve(clearingHouse.address, parseTokenAmount(10n ** 5n, 6));
  await clearingHouse.updateMargin(adminAccountNo, truncate(settlementToken.address), parseTokenAmount(10n ** 5n, 6));

  const lpToken = (await hre.ethers.getContractAt(
    '@openzeppelin/contracts/token/ERC20/ERC20.sol:ERC20',
    GMX_ECOSYSTEM_ADDRESSES.StakedGlp,
  )) as ERC20;

  const weth = (await hre.ethers.getContractAt(
    '@openzeppelin/contracts/token/ERC20/ERC20.sol:ERC20',
    addresses.WETH,
  )) as ERC20;

  const swapManager = await (await hre.ethers.getContractFactory('SwapManager')).deploy();
  const logic = await (
    await hre.ethers.getContractFactory('Logic', {
      libraries: {
        ['contracts/libraries/SwapManager.sol:SwapManager']: swapManager.address,
      },
    })
  ).deploy();

  const [signer] = await hre.ethers.getSigners();
  let gmxYieldStrategyFactory = await new GMXYieldStrategy__factory(
    {
      ['contracts/libraries/Logic.sol:Logic']: logic.address,
    },
    admin,
  );

  const gmxYieldStrategy = await gmxYieldStrategyFactory.deploy();

  await collateralToken.grantRole(await collateralToken.MINTER_ROLE(), gmxYieldStrategy.address);

  await collateralToken.approve(clearingHouse.address, parseTokenAmount(10n ** 10n, 18));

  await settlementToken.approve(clearingHouse.address, parseTokenAmount(10n ** 5n, 6));

  await gmxYieldStrategy.initialize({
    eightyTwentyRangeStrategyVaultInitParams: {
      baseVaultInitParams: {
        rageErc4626InitParams: {
          asset: lpToken.address,
          name: 'TriCrypto Shares',
          symbol: 'TCS',
        },
        ethPoolId,
        rageClearingHouse: clearingHouse.address,
        swapSimulator: pool0.SwapSimulator.address,
        rageCollateralToken: collateralToken.address,
        rageSettlementToken: settlementToken.address,
        clearingHouseLens: pool0.clearingHouseLens.address,
      },
      closePositionSlippageSqrtToleranceBps: closePositionSlippageSqrtToleranceBps,
      resetPositionThresholdBps: resetPositionThresholdBps,
      minNotionalPositionToCloseThreshold: minNotionalPositionToCloseThreshold,
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
      asset: lpToken.address,
      name: 'TriCrypto Shares',
      symbol: 'TCS',
    },
    weth: addresses.WETH,
    usdc: addresses.USDC, // TODO needs to change
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
  await gmxYieldStrategy.updateBaseParams(ethers.constants.MaxUint256, admin.address, 0, 0);
  await gmxYieldStrategy.updateGMXParams(100, 10, 0, gmxBatchingManager.address, glpStakingManager.address);

  await gmxBatchingManager.addVault(gmxYieldStrategy.address);
  await gmxBatchingManager.grantAllowances(gmxYieldStrategy.address);

  await glpStakingManager.grantAllowances();
  await gmxYieldStrategy.grantAllowances();

  await collateralToken.grantRole(await collateralToken.MINTER_ROLE(), gmxYieldStrategy.address);
  const vaultAccountNo = await gmxYieldStrategy.rageAccountNo();

  await lpToken.connect(user1).approve(gmxYieldStrategy.address, ethers.constants.MaxUint256);
  await lpToken.connect(user2).approve(gmxYieldStrategy.address, ethers.constants.MaxUint256);

  await gmxYieldStrategy.updateBaseParams(ethers.constants.MaxUint256, signer.address, 0, 0);
  await gmxYieldStrategy.grantAllowances();

  return {
    glp,
    sGLP,
    fsGLP,
    usdc,
    weth,
    lpToken,
    gmxYieldStrategy,
    clearingHouse,
    collateralToken,
    collateralTokenOracle,
    settlementToken,
    vaultAccountNo,
    ethPoolId,
    ethPool: pool0,
    clearingHouseLens: pool0.clearingHouseLens,
    swapSimulator: pool0.SwapSimulator,
    user1,
    user2,
    trader0,
    trader0AccountNo,
    admin,
    adminAccountNo,
    glpStakingManager,
  };
});
