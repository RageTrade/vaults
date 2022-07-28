import { truncate } from '@ragetrade/sdk';
import { parseUnits } from 'ethers/lib/utils';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { GMXYieldStrategy, GMXYieldStrategy__factory, ClearingHouseLens__factory } from '../typechain-types';
import { getNetworkInfo, waitConfirmations } from './network-info';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const {
    deployments: { get, deploy, save, execute, read },
    getNamedAccounts,
  } = hre;

  const { deployer } = await getNamedAccounts();

  const proxyAdminDeployment = await get('ProxyAdmin');
  const gmxYieldStrategyLogicDeployment = await get('GMXYieldStrategyLogic');

  const networkInfo = getNetworkInfo(hre.network.config.chainId ?? 31337);

  const clearingHouseAddress: string = (await get('ClearingHouse')).address;
  const settlementTokenAddress: string = (await get('SettlementToken')).address;
  const ethPoolId: string = truncate((await get('ETH-vToken')).address);

  const collateralTokenDeployment = await get('CollateralToken');

  const clearingHouseLens = ClearingHouseLens__factory.connect(
    (await get('ClearingHouseLens')).address,
    await hre.ethers.getSigner(deployer),
  );

  const initializeArg: GMXYieldStrategy.GMXYieldStrategyInitParamsStruct = {
    eightyTwentyRangeStrategyVaultInitParams: {
      baseVaultInitParams: {
        rageErc4626InitParams: {
          asset: networkInfo.SGLP_ADDRESS,
          name: '80-20 TriCrypto Strategy',
          symbol: 'TCS',
        },
        ethPoolId,
        swapSimulator: (await get('SwapSimulator')).address,
        clearingHouseLens: clearingHouseLens.address,
        rageClearingHouse: clearingHouseAddress,
        rageCollateralToken: collateralTokenDeployment.address,
        rageSettlementToken: settlementTokenAddress,
      },
      closePositionSlippageSqrtToleranceBps: 150,
      resetPositionThresholdBps: 2000,
      minNotionalPositionToCloseThreshold: 100e6,
    },
    gmx: networkInfo.GMX_ADDRESS,
    glp: networkInfo.GLP_ADDRESS,
    weth: networkInfo.WETH_ADDRESS,
    esGMX: networkInfo.ESGMX_ADDRESS, // TODO needs to change
    glpManager: networkInfo.GLP_MANAGER_ADDRESS,
    rewardRouter: networkInfo.REWARD_ROUTER_ADDRESS,
  };

  const ProxyDeployment = await deploy('GMXYieldStrategy', {
    contract: 'TransparentUpgradeableProxy',
    from: deployer,
    log: true,
    args: [
      gmxYieldStrategyLogicDeployment.address,
      proxyAdminDeployment.address,
      GMXYieldStrategy__factory.createInterface().encodeFunctionData('initialize', [initializeArg]),
    ],
    estimateGasExtra: 1_000_000,
    waitConfirmations,
  });
  await save('GMXYieldStrategy', { ...ProxyDeployment, abi: gmxYieldStrategyLogicDeployment.abi });

  if (ProxyDeployment.newlyDeployed) {
    await execute(
      'GMXYieldStrategy',
      { from: deployer, estimateGasExtra: 1_000_000, waitConfirmations },
      'grantAllowances',
    );

    await execute(
      'GMXYieldStrategy',
      { from: deployer, estimateGasExtra: 1_000_000, waitConfirmations },
      'updateBaseParams',
      parseUnits(networkInfo.DEPOSIT_CAP_C3CLT.toString(), 18),
      networkInfo.KEEPER_ADDRESS,
      86400, // rebalanceTimeThreshold
      500, // rebalancePriceThresholdBps
    );

    const gbm = await get('GMXBatchingManager');
    await execute(
      'GMXBatchingManager',
      { from: deployer, estimateGasExtra: 1_000_000, waitConfirmations },
      'initialize',
      networkInfo.SGLP_ADDRESS,
      networkInfo.REWARD_ROUTER_ADDRESS,
      networkInfo.GLP_MANAGER_ADDRESS,
      gbm.address,
      networkInfo.KEEPER_ADDRESS,
    );

    await execute(
      'GMXYieldStrategy',
      { from: deployer, estimateGasExtra: 1_000_000, waitConfirmations },
      'updateGMXParams',
      1000, // feeBps
      gbm.address, // batchingManager
    );

    // transfer ownership to team multisig
    await execute(
      'GMXYieldStrategy',
      { from: deployer, estimateGasExtra: 1_000_000, waitConfirmations },
      'transferOwnership',
      networkInfo.MULTISIG,
    );

    const MINTER_ROLE = await read('CollateralToken', 'MINTER_ROLE');
    await execute(
      'CollateralToken',
      { from: deployer, estimateGasExtra: 1_000_000, waitConfirmations },
      'grantRole',
      MINTER_ROLE,
      ProxyDeployment.address,
    );
  }
};

export default func;

func.tags = ['GMXYieldStrategy'];
func.dependencies = [
  'GMXBatchingManager',
  'GMXYieldStrategyLogic',
  'CollateralToken',
  'ProxyAdmin',
  'vETH',
  'SwapSimulator',
];
