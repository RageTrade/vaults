import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { getNetworkInfo, waitConfirmations } from './network-info';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const {
    deployments: { deploy, get, execute },
    getNamedAccounts,
  } = hre;

  const { deployer } = await getNamedAccounts();

  const networkInfo = getNetworkInfo(hre.network.config.chainId ?? 31337);

  await deploy('GMXBatchingManager', {
    contract: 'GMXBatchingManager',
    from: deployer,
    log: true,
    waitConfirmations,
  });

  //   if (gbm.newlyDeployed) {
  //     console.log('se87rngfie76rfgbiw');

  //     await execute(
  //       'GMXBatchingManager',
  //       { from: deployer, estimateGasExtra: 1_000_000, waitConfirmations },
  //       'initialize',
  //       networkInfo.SGLP_ADDRESS,
  //       networkInfo.REWARD_ROUTER_ADDRESS,
  //       networkInfo.GLP_MANAGER_ADDRESS,
  //       gys.address,
  //       networkInfo.KEEPER_ADDRESS,
  //     );

  //     console.log('se87rngfie76rfgbiw', gbm.address);
  //     await execute(
  //       'GMXYieldStrategy',
  //       { from: deployer, estimateGasExtra: 1_000_000, waitConfirmations },
  //       'updateGMXParams',
  //       1000, // feeBps
  //       gbm.address, // batchingManager
  //     );
  //     console.log('se87rngfie76rfgbiw');
  //   }
};

export default func;

func.tags = ['GMXBatchingManager'];
// func.dependencies = ['GMXYieldStrategy'];
