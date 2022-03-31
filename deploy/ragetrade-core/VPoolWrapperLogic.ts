import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

// Not to be deployed during the deploy task
export const skip = () => true;

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const {
    deployments: { deploy },
    getNamedAccounts,
  } = hre;

  const { deployer } = await getNamedAccounts();

  const deployment = await deploy('VPoolWrapperLogic', {
    contract: 'VPoolWrapper',
    from: deployer,
    log: true,
  });

  if (deployment.newlyDeployed && hre.network.config.chainId !== 31337) {
    await hre.tenderly.push({
      name: 'VPoolWrapper',
      address: deployment.address,
    });
  }
};

export default func;

func.tags = ['VPoolWrapperLogic'];
