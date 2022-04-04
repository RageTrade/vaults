import { expect } from 'chai';
import { BigNumber } from 'ethers';
import hre, { ethers } from 'hardhat';

import addresses from './fixtures/addresses';
import { curveYieldStrategyFixture } from './fixtures/curve-yield-strategy';

const within = (value: BigNumber, start: BigNumber, end: BigNumber): Boolean => {
  if (value.gte(start) && value.lte(end)) return true;
  return false;
};

// remove when https://github.com/NomicFoundation/hardhat/issues/2234 is closed
function revertReason(reason: string) {
  return `Error: VM Exception while processing transaction: reverted with reason string ${reason}`
}

describe('CurveYieldStrategy', () => {
  beforeEach(async () => {
    await curveYieldStrategyFixture();
  });

  describe('#deposit', () => {
    it('should perform approvals by vault', async () => {
      const [admin] = await hre.ethers.getSigners();
      const { crv, usdt, lpToken, curveYieldStrategyTest } = await curveYieldStrategyFixture();
      const curveYieldStrategy = curveYieldStrategyTest.connect(admin);

      const before = await Promise.all([
        crv.allowance(curveYieldStrategy.address, addresses.ROUTER),
        usdt.allowance(curveYieldStrategy.address, addresses.TRICRYPTO_POOL),
        lpToken.allowance(curveYieldStrategy.address, addresses.TRICRYPTO_POOL),
      ]);

      await curveYieldStrategy.grantAllowances();

      const after = await Promise.all([
        crv.allowance(curveYieldStrategy.address, addresses.ROUTER),
        usdt.allowance(curveYieldStrategy.address, addresses.TRICRYPTO_POOL),
        lpToken.allowance(curveYieldStrategy.address, addresses.TRICRYPTO_POOL),
      ]);

      expect(before).to.be.eql([BigNumber.from(0), BigNumber.from(0), BigNumber.from(0)]);
      expect(after).to.be.eql([ethers.constants.MaxUint256, ethers.constants.MaxUint256, ethers.constants.MaxUint256]);
    });

    it('should transfer lp tokens & mint shares', async () => {
      const [admin, user1, user2] = await hre.ethers.getSigners();
      const { gauge, lpToken, curveYieldStrategyTest: curveYieldStrategy } = await curveYieldStrategyFixture();

      await hre.network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [addresses.LP_TOKEN_WHALE],
      });

      const whale = await ethers.getSigner(addresses.LP_TOKEN_WHALE);

      const amount1 = BigNumber.from(10).pow(18).mul(40);
      const amount2 = BigNumber.from(10).pow(18).mul(10);
      const amount = amount1.add(amount2);

      await curveYieldStrategy.connect(admin).updateDepositCap(amount);

      await lpToken.connect(whale).transfer(user1.address, amount1);
      await lpToken.connect(whale).transfer(user2.address, amount2);

      await lpToken.connect(user1).approve(curveYieldStrategy.address, amount1);
      await lpToken.connect(user2).approve(curveYieldStrategy.address, amount2);

      const [
        user1LpBalBefore,
        user2LpBalBefore,
        gaugeLpBalBefore,
        vaultLpBalBefore,
        user1SharesBalBefore,
        user2SharesBalBefore,
        totalAssetvalueBefore,
        totalSharesMintedBefore,
      ] = await Promise.all([
        lpToken.balanceOf(user1.address),
        lpToken.balanceOf(user2.address),
        lpToken.balanceOf(gauge.address),
        lpToken.balanceOf(curveYieldStrategy.address),
        curveYieldStrategy.balanceOf(user1.address),
        curveYieldStrategy.balanceOf(user2.address),
        curveYieldStrategy.totalSupply(),
        curveYieldStrategy.totalAssets(),
      ]);

      await curveYieldStrategy.connect(user1).deposit(amount1, user1.address);

      const [
        user1LpBalAfterFirstDeposit,
        user2LpBalAfterFirstDeposit,
        gaugeLpBalAfterFirstDeposit,
        vaultLpBalAfterFirstDeposit,
        user1SharesBalAfterFirstDeposit,
        user2SharesBalAfterFirstDeposit,
        totalAssetvalueAfterFirstDeposit,
        totalSharesMintedAfterFirstDeposit,
      ] = await Promise.all([
        lpToken.balanceOf(user1.address),
        lpToken.balanceOf(user2.address),
        lpToken.balanceOf(gauge.address),
        lpToken.balanceOf(curveYieldStrategy.address),
        curveYieldStrategy.balanceOf(user1.address),
        curveYieldStrategy.balanceOf(user2.address),
        curveYieldStrategy.totalSupply(),
        curveYieldStrategy.totalAssets(),
      ]);

      await hre.network.provider.send('evm_increaseTime', [1_000_000]);
      await hre.network.provider.send('evm_mine', []);

      await curveYieldStrategy.connect(user2).deposit(amount2, user2.address);

      const [
        user1LpBalAfterSecondDeposit,
        user2LpBalAfterSecondDeposit,
        gaugeLpBalAfterSecondDeposit,
        vaultLpBalAfterSecondDeposit,
        user1SharesBalAfterSecondDeposit,
        user2SharesBalAfterSecondDeposit,
        totalAssetvalueAfterSecondDeposit,
        totalSharesMintedAfterSecondDeposit,
      ] = await Promise.all([
        lpToken.balanceOf(user1.address),
        lpToken.balanceOf(user2.address),
        lpToken.balanceOf(gauge.address),
        lpToken.balanceOf(curveYieldStrategy.address),
        curveYieldStrategy.balanceOf(user1.address),
        curveYieldStrategy.balanceOf(user2.address),
        curveYieldStrategy.totalSupply(),
        curveYieldStrategy.totalAssets(),
      ]);

      expect(user1LpBalBefore).to.be.eq(amount1);
      expect(user2LpBalBefore).to.be.eq(amount2);

      expect(vaultLpBalBefore).to.be.eq(0);
      expect(gaugeLpBalBefore).to.be.gt(0);

      expect(user1SharesBalBefore).to.be.eq(0);
      expect(user2SharesBalBefore).to.be.eq(0);

      expect(totalAssetvalueBefore).to.be.eq(0);
      expect(totalSharesMintedBefore).to.be.eq(0);

      expect(user1LpBalBefore.sub(user1LpBalAfterFirstDeposit)).to.be.eq(user1LpBalBefore);
      expect(user2LpBalBefore.sub(user2LpBalAfterFirstDeposit)).to.be.eq(0);

      expect(vaultLpBalAfterFirstDeposit).to.be.eq(0);
      expect(gaugeLpBalAfterFirstDeposit).to.be.eq(gaugeLpBalBefore.add(amount1));

      expect(user1SharesBalAfterFirstDeposit).to.be.eq(amount1);
      expect(user2SharesBalAfterFirstDeposit).to.be.eq(0);

      expect(totalAssetvalueAfterFirstDeposit).to.be.eq(amount1);
      expect(totalSharesMintedAfterFirstDeposit).to.be.eq(amount1);

      expect(user1LpBalAfterFirstDeposit.sub(user1LpBalAfterSecondDeposit)).to.be.eq(0);
      expect(user2LpBalAfterFirstDeposit.sub(user2LpBalAfterSecondDeposit)).to.be.eq(amount2);

      expect(vaultLpBalAfterSecondDeposit).to.be.eq(0);
      expect(gaugeLpBalAfterSecondDeposit).to.be.eq(gaugeLpBalAfterFirstDeposit.add(amount2));

      expect(user1SharesBalAfterSecondDeposit).to.be.eq(amount1);
      expect(user2SharesBalAfterSecondDeposit).to.be.eq(amount2);

      expect(totalAssetvalueAfterSecondDeposit).to.be.eq(amount1.add(amount2));
      expect(totalSharesMintedAfterSecondDeposit).to.be.eq(amount1.add(amount2));
    });
  });

  describe('#collateral-shifting', () => {
    it('should deposit & withdraw usdc', async () => {
      const [, user1, user2] = await hre.ethers.getSigners();
      const { usdc, gauge, lpToken, curveYieldStrategyTest: curveYieldStrategy } = await curveYieldStrategyFixture();

      await hre.network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [addresses.USDC_WHALE],
      });

      const whale = await ethers.getSigner(addresses.USDC_WHALE);

      const amount1 = BigNumber.from(10).pow(6).mul(600);
      const amount2 = BigNumber.from(10).pow(6).mul(400);
      const amount = amount1.add(amount2);

      await usdc.connect(whale).transfer(user1.address, amount1);
      await usdc.connect(whale).transfer(user2.address, amount2);

      await usdc.connect(user1).approve(curveYieldStrategy.address, amount1);
      await usdc.connect(user2).approve(curveYieldStrategy.address, amount2);

      const [user1UsdcBalBefore, user2UsdcBalBefore, vaultUsdcBalBefore, gaugeLpBalBefore, vaultLpBalBefore] =
        await Promise.all([
          usdc.balanceOf(user1.address),
          usdc.balanceOf(user2.address),
          usdc.balanceOf(curveYieldStrategy.address),
          lpToken.balanceOf(gauge.address),
          lpToken.balanceOf(curveYieldStrategy.address),
        ]);

      await curveYieldStrategy.connect(user1).depositUsdc(amount1);

      const [
        user1UsdcBalAfterFirstDeposit,
        user2UsdcBalAfterFirstDeposit,
        vaultUsdcBalAfterFirstDeposit,
        gaugeLpBalAfterFirstDeposit,
        vaultLpBalAfterFirstDeposit,
      ] = await Promise.all([
        usdc.balanceOf(user1.address),
        usdc.balanceOf(user2.address),
        usdc.balanceOf(curveYieldStrategy.address),
        lpToken.balanceOf(gauge.address),
        lpToken.balanceOf(curveYieldStrategy.address),
      ]);

      await curveYieldStrategy.connect(user2).depositUsdc(amount2);

      const [
        user1UsdcBalAfterSecondDeposit,
        user2UsdcBalAfterSecondDeposit,
        vaultUsdcBalAfterSecondDeposit,
        gaugeLpBalAfterSecondDeposit,
        vaultLpBalAfterSecondDeposit,
      ] = await Promise.all([
        usdc.balanceOf(user1.address),
        usdc.balanceOf(user2.address),
        usdc.balanceOf(curveYieldStrategy.address),
        lpToken.balanceOf(gauge.address),
        lpToken.balanceOf(curveYieldStrategy.address),
      ]);

      expect(user1UsdcBalBefore).to.be.eq(amount1);
      expect(user2UsdcBalBefore).to.be.eq(amount2);
      expect(vaultUsdcBalBefore).to.be.eq(0);

      expect(gaugeLpBalBefore).to.be.gt(0);
      expect(vaultLpBalBefore).to.be.eq(0);

      expect(user1UsdcBalAfterFirstDeposit).to.be.eq(0);
      expect(user2UsdcBalAfterFirstDeposit).to.be.eq(amount2);
      expect(vaultUsdcBalAfterFirstDeposit).to.be.eq(0);

      expect(gaugeLpBalAfterFirstDeposit).to.be.gt(gaugeLpBalBefore);
      expect(vaultLpBalAfterFirstDeposit).to.be.eq(0);

      expect(user1UsdcBalAfterSecondDeposit).to.be.eq(user1UsdcBalAfterFirstDeposit);
      expect(user2UsdcBalAfterSecondDeposit).to.be.eq(0);
      expect(vaultUsdcBalAfterSecondDeposit).to.be.eq(0);

      expect(gaugeLpBalAfterSecondDeposit).to.be.gt(gaugeLpBalAfterFirstDeposit);
      expect(vaultLpBalAfterSecondDeposit).to.be.eq(0);
    });
  });

  describe('#withdraw', () => {
    it('should pull LP from pool', async () => {
      const [admin, user1, user2] = await hre.ethers.getSigners();
      const { gauge, lpToken, curveYieldStrategyTest: curveYieldStrategy } = await curveYieldStrategyFixture();

      await hre.network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [addresses.LP_TOKEN_WHALE],
      });

      const whale = await ethers.getSigner(addresses.LP_TOKEN_WHALE);

      const amount1 = BigNumber.from(10).pow(18).mul(25);
      const amount2 = BigNumber.from(10).pow(18).mul(25);
      const amount = amount1.add(amount2);

      await curveYieldStrategy.connect(admin).updateDepositCap(amount);

      await lpToken.connect(whale).transfer(user1.address, amount1);
      await lpToken.connect(whale).transfer(user2.address, amount2);

      await lpToken.connect(user1).approve(curveYieldStrategy.address, amount1);
      await lpToken.connect(user2).approve(curveYieldStrategy.address, amount2);

      await curveYieldStrategy.connect(user1).deposit(amount1, user1.address);
      await hre.network.provider.send('evm_increaseTime', [1_000_000]);
      await hre.network.provider.send('evm_mine', []);

      await curveYieldStrategy.connect(user2).deposit(amount2, user2.address);
      await hre.network.provider.send('evm_increaseTime', [1_000_000]);
      await hre.network.provider.send('evm_mine', []);

      const [
        user1LpBalBefore,
        user2LpBalBefore,
        gaugeLpBalBefore,
        vaultLpBalBefore,
        user1SharesBalBefore,
        user2SharesBalBefore,
        totalAssetvalueBefore,
        totalSharesMintedBefore,
      ] = await Promise.all([
        lpToken.balanceOf(user1.address),
        lpToken.balanceOf(user2.address),
        lpToken.balanceOf(gauge.address),
        lpToken.balanceOf(curveYieldStrategy.address),
        curveYieldStrategy.balanceOf(user1.address),
        curveYieldStrategy.balanceOf(user2.address),
        curveYieldStrategy.totalAssets(),
        curveYieldStrategy.totalSupply(),
      ]);

      const pricePerShareBefore = totalAssetvalueBefore.div(totalSharesMintedBefore);

      const toWithdraw1 = await curveYieldStrategy.convertToAssets(user1SharesBalBefore);
      await curveYieldStrategy.connect(user1).withdraw(toWithdraw1, user1.address, user1.address);

      await hre.network.provider.send('evm_increaseTime', [1_000_000]);
      await hre.network.provider.send('evm_mine', []);

      const [
        user1LpBalAfterFirstWithdraw,
        user2LpBalAfterFirstWithdraw,
        gaugeLpBalAfterFirstWithdraw,
        vaultLpBalAfterFirstWithdraw,
        user1SharesBalAfterFirstWithdraw,
        user2SharesBalAfterFirstWithdraw,
        totalAssetvalueAfterFirstWithdraw,
        totalSharesMintedAfterFirstWithdraw,
      ] = await Promise.all([
        lpToken.balanceOf(user1.address),
        lpToken.balanceOf(user2.address),
        lpToken.balanceOf(gauge.address),
        lpToken.balanceOf(curveYieldStrategy.address),
        curveYieldStrategy.balanceOf(user1.address),
        curveYieldStrategy.balanceOf(user2.address),
        curveYieldStrategy.totalAssets(),
        curveYieldStrategy.totalSupply(),
      ]);

      const pricePerShareAfterFirstWithdraw = totalAssetvalueAfterFirstWithdraw.div(
        totalSharesMintedAfterFirstWithdraw,
      );

      const toWithdraw2 = await curveYieldStrategy.convertToAssets(user2SharesBalAfterFirstWithdraw);
      await curveYieldStrategy.connect(user2).withdraw(toWithdraw2, user2.address, user2.address);

      await hre.network.provider.send('evm_increaseTime', [1_000_000]);
      await hre.network.provider.send('evm_mine', []);

      const [
        user1LpBalAfterSecondWithdraw,
        user2LpBalAfterSecondWithdraw,
        gaugeLpBalAfterSecondWithdraw,
        vaultLpBalAfterSecondWithdraw,
        user1SharesBalAfterSecondWithdraw,
        user2SharesBalAfterSecondWithdraw,
        totalAssetvalueAfterSecondWithdraw,
        totalSharesMintedAfterSecondWithdraw,
      ] = await Promise.all([
        lpToken.balanceOf(user1.address),
        lpToken.balanceOf(user2.address),
        lpToken.balanceOf(gauge.address),
        lpToken.balanceOf(curveYieldStrategy.address),
        curveYieldStrategy.balanceOf(user1.address),
        curveYieldStrategy.balanceOf(user2.address),
        curveYieldStrategy.totalAssets(),
        curveYieldStrategy.totalSupply(),
      ]);

      const pricePerShareSecondWithdraw = totalAssetvalueAfterSecondWithdraw.div(totalSharesMintedAfterSecondWithdraw);

      expect(user1LpBalBefore).to.be.eq(0);
      expect(user2LpBalBefore).to.be.eq(0);

      expect(vaultLpBalBefore).to.be.eq(0);
      expect(gaugeLpBalBefore).to.be.gt(totalAssetvalueBefore);

      expect(user1SharesBalBefore).to.be.eq(amount1);
      expect(user2SharesBalBefore).to.be.eq(amount2);

      expect(totalAssetvalueBefore).to.be.gte(amount1.add(amount2));
      expect(totalSharesMintedBefore).to.be.eq(user1SharesBalBefore.add(user2SharesBalBefore));

      expect(user1LpBalAfterFirstWithdraw).to.be.eq(pricePerShareBefore.mul(user1SharesBalBefore));
      expect(user2LpBalAfterFirstWithdraw).to.be.eq(0);

      expect(vaultLpBalAfterFirstWithdraw).to.be.eq(0);
      expect(gaugeLpBalAfterFirstWithdraw).to.be.lt(gaugeLpBalBefore);

      const fraction1 = user1SharesBalBefore.mul(totalAssetvalueBefore).div(totalSharesMintedBefore);
      const shareFraction1 = await curveYieldStrategy.convertToShares(fraction1);

      expect(within(user1SharesBalAfterFirstWithdraw, BigNumber.from(0), user1SharesBalBefore.sub(shareFraction1))).to
        .be.true;
      expect(user2SharesBalAfterFirstWithdraw).to.be.eq(user2SharesBalBefore);

      expect(within(totalAssetvalueBefore.sub(totalAssetvalueAfterFirstWithdraw), BigNumber.from(0), shareFraction1)).to
        .be.true;

      expect(
        within(
          totalSharesMintedAfterFirstWithdraw.sub(user1SharesBalBefore),
          BigNumber.from(0),
          user1SharesBalBefore.sub(shareFraction1),
        ),
      ).to.be.true;

      const fraction2 = toWithdraw2.mul(totalAssetvalueAfterFirstWithdraw).div(totalSharesMintedAfterFirstWithdraw);
      const shareFraction2 = await curveYieldStrategy.convertToShares(fraction2);

      expect(user1LpBalAfterSecondWithdraw).to.be.eq(user1LpBalAfterFirstWithdraw);
      expect(user2LpBalAfterSecondWithdraw).to.be.eq(toWithdraw2);

      expect(vaultLpBalAfterSecondWithdraw).to.be.eq(0);
      expect(gaugeLpBalAfterSecondWithdraw).to.be.lt(gaugeLpBalAfterFirstWithdraw);

      expect(user1SharesBalAfterSecondWithdraw).to.be.eq(user1SharesBalAfterFirstWithdraw);
      expect(
        within(
          user2SharesBalAfterSecondWithdraw,
          BigNumber.from(0),
          shareFraction2.sub(user2SharesBalAfterFirstWithdraw),
        ),
      ).to.be.true;

      expect(totalAssetvalueAfterSecondWithdraw).to.be.eq(
        totalAssetvalueAfterFirstWithdraw.sub(user2LpBalAfterSecondWithdraw),
      );
      expect(
        within(
          totalSharesMintedAfterSecondWithdraw,
          BigNumber.from(0),
          shareFraction2.sub(user2SharesBalAfterFirstWithdraw),
        ),
      ).to.be.true;
    });

    it('should harvest & compound CRV from gauge', async () => {
      const [admin, user] = await hre.ethers.getSigners();
      const { gauge, lpToken, curveYieldStrategyTest: curveYieldStrategy } = await curveYieldStrategyFixture();

      await hre.network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [addresses.LP_TOKEN_WHALE],
      });

      const whale = await ethers.getSigner(addresses.LP_TOKEN_WHALE);

      const amount = BigNumber.from(10).pow(18).mul(50);

      await curveYieldStrategy.connect(admin).updateDepositCap(amount);

      await lpToken.connect(whale).transfer(user.address, amount);
      await lpToken.connect(user).approve(curveYieldStrategy.address, amount);

      await curveYieldStrategy.connect(user).deposit(amount, user.address);

      const gaugeLpBalBefore = await lpToken.balanceOf(gauge.address);
      const pricePerShareBefore = (await curveYieldStrategy.totalAssets()).div(await curveYieldStrategy.totalSupply());

      await hre.network.provider.send('evm_increaseTime', [10_000_000]);
      await hre.network.provider.send('evm_mine', []);

      await gauge.claimable_reward_write(curveYieldStrategy.address, addresses.CRV);
      await curveYieldStrategy.harvestFees();

      const gaugeLpBalAfter = await lpToken.balanceOf(gauge.address);
      const pricePerShareAfter = await curveYieldStrategy.convertToAssets(BigNumber.from(10).pow(18));

      expect(gaugeLpBalAfter.sub(gaugeLpBalBefore)).to.be.gt(0);
      expect(pricePerShareAfter.sub(pricePerShareBefore)).to.be.gt(0);

      const lpTokenGains = gaugeLpBalAfter.sub(gaugeLpBalBefore);
      const totalLpTokens = amount.add(lpTokenGains);

      expect(
        within(
          pricePerShareAfter
            .mul(amount)
            .div(BigNumber.from(10).pow(18))
            .sub(await curveYieldStrategy.totalAssets()),
          BigNumber.from(-1).mul(10 ** 2),
          BigNumber.from(10 ** 2),
        ),
      ).to.be.true;
    });

    it('should deduct rage fee (10% which can be changed)', async () => {
      const [admin, user1, user2] = await hre.ethers.getSigners();
      const {
        crv,
        gauge,
        lpToken,
        lpOracle,
        crvOracle,
        uniswapQuoter,
        curveYieldStrategyTest: curveYieldStrategy,
      } = await curveYieldStrategyFixture();

      await hre.network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [addresses.LP_TOKEN_WHALE],
      });

      const whale = await ethers.getSigner(addresses.LP_TOKEN_WHALE);

      const amount1 = BigNumber.from(10).pow(18).mul(40);
      const amount2 = BigNumber.from(10).pow(18).mul(10);
      const amount = amount1.add(amount2);

      await curveYieldStrategy.connect(admin).updateDepositCap(amount);

      await lpToken.connect(whale).transfer(user1.address, amount1);
      await lpToken.connect(whale).transfer(user2.address, amount2);

      await lpToken.connect(user1).approve(curveYieldStrategy.address, amount1);
      await lpToken.connect(user2).approve(curveYieldStrategy.address, amount2);

      await curveYieldStrategy.connect(user1).deposit(amount1, user1.address);
      await curveYieldStrategy.connect(user2).deposit(amount2, user1.address);

      const [totalAssetsBefore, crvBalanceBefore] = await Promise.all([
        curveYieldStrategy.convertToAssets(amount),
        crv.balanceOf(curveYieldStrategy.address),
      ]);

      await hre.network.provider.send('evm_increaseTime', [10_000_000]);
      await hre.network.provider.send('evm_mine', []);

      await gauge.claimable_reward_write(curveYieldStrategy.address, addresses.CRV);
      const claimableReward = await gauge.claimable_reward(curveYieldStrategy.address, addresses.CRV);
      await curveYieldStrategy.harvestFees();

      const [totalAssetsAfterHarvest, crvBalanceAfterHarvest] = await Promise.all([
        curveYieldStrategy.convertToAssets(amount),
        crv.balanceOf(curveYieldStrategy.address),
      ]);

      // const out = await uniswapQuoter.quoteExactInput(
      //   '0x11cdb42b0eb46d95f990bedd4695a6e3fa034978000bb882af49447d8a07e3bd95bd0d56f35241523fbab10001f4fd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
      //   claimableReward.mul(BigNumber.from(9)).div(10)
      // )

      await curveYieldStrategy.withdrawFees();

      const [totalAssetsAfterWithdrawFees, crvBalanceAfterWithdrawFees] = await Promise.all([
        curveYieldStrategy.convertToAssets(amount),
        crv.balanceOf(curveYieldStrategy.address),
      ]);

      expect(totalAssetsAfterHarvest).to.be.gt(totalAssetsBefore);
      expect(totalAssetsAfterHarvest).to.be.eq(totalAssetsAfterWithdrawFees);

      expect(crvBalanceBefore).to.be.eq(BigNumber.from(0));
      expect(crvBalanceAfterWithdrawFees).to.be.eq(BigNumber.from(0));

      // admin fees : 0.1 * total crv rewards
      // total crv rewards : admin fees + converted into LP
      // therefore, converted into LP : 9 * admin fees

      // total crv rewards : increase in value of shares

      // total earned : total crv * price of crv
      // total fees : total earned * 0.1
      // total increase in value of shares : total earned * 0.9
      // total value of shares : old value of shares + new value of shares

      const pricePerLP = await lpOracle.lp_price();
      // console.log('PRICE PER LP : ', pricePerLP);

      const { answer } = await crvOracle.latestRoundData();
      // console.log('PRICE PER CRV : ', answer.div(10 ** 8));

      const fees = crvBalanceAfterHarvest.mul(answer).div(BigNumber.from(10).pow(8));
      // console.log('FEES : ', fees);

      const convertedToLp = BigNumber.from(9).mul(fees);
      // console.log('CONVERTED TO LP : ', convertedToLp);

      const increaseInvalueOfShares = totalAssetsAfterHarvest.sub(totalAssetsBefore);
      // console.log('INCREASE IN VALUE OF SHARES : ', increaseInvalueOfShares);

      // expect(convertedToLp.mul(10).div(11)).to.be.eq(
      //   increaseInvalueOfShares.mul(pricePerLP).div(BigNumber.from(10).pow(18)),
      // );

      // const notionalIncrease = totalAssetsAfterHarvest.sub(totalAssetsBefore).mul(pricePerLP);

      // const netCrvValue = answer.div().mul(crvBalanceAfterHarvest);

      // expect(notionalIncrease).to.be.eq(netCrvValue.mul(11));
    });
  });

  describe('#price-and-value-getters', () => {
    it('should calculate total assets exclusive of fees', async () => {
      const [admin, user1, user2] = await hre.ethers.getSigners();
      const { gauge, lpToken, curveYieldStrategyTest: curveYieldStrategy } = await curveYieldStrategyFixture();

      await hre.network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [addresses.LP_TOKEN_WHALE],
      });

      const whale = await ethers.getSigner(addresses.LP_TOKEN_WHALE);

      const amount1 = BigNumber.from(10).pow(18).mul(40);
      const amount2 = BigNumber.from(10).pow(18).mul(10);
      const amount = amount1.add(amount2);

      await curveYieldStrategy.connect(admin).updateDepositCap(amount);

      await lpToken.connect(whale).transfer(user1.address, amount1);
      await lpToken.connect(whale).transfer(user2.address, amount2);

      await lpToken.connect(user1).approve(curveYieldStrategy.address, amount1);
      await lpToken.connect(user2).approve(curveYieldStrategy.address, amount2);

      await curveYieldStrategy.connect(user1).deposit(amount1, user1.address);
      await hre.network.provider.send('evm_increaseTime', [10_000_000]);
      await hre.network.provider.send('evm_mine', []);

      await curveYieldStrategy.connect(user2).deposit(amount2, user2.address);
      await hre.network.provider.send('evm_increaseTime', [10_000_000]);
      await hre.network.provider.send('evm_mine', []);

      await gauge.claimable_reward_write(curveYieldStrategy.address, addresses.CRV);
      await curveYieldStrategy.harvestFees();

      const before = await curveYieldStrategy.totalAssets();

      await curveYieldStrategy.withdrawFees();

      const after = await curveYieldStrategy.totalAssets();

      expect(after).to.be.eq(before);
    });

    it('getPriceX128', async () => {
      const [admin, user1] = await hre.ethers.getSigners();
      const {
        gauge,
        lpToken,
        lpOracle,
        curveYieldStrategyTest: curveYieldStrategy,
      } = await curveYieldStrategyFixture();

      await hre.network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [addresses.LP_TOKEN_WHALE],
      });

      const whale = await ethers.getSigner(addresses.LP_TOKEN_WHALE);

      const amount = BigNumber.from(10).pow(18).mul(40);

      await curveYieldStrategy.connect(admin).updateDepositCap(amount);

      await lpToken.connect(whale).transfer(user1.address, amount);

      await lpToken.connect(user1).approve(curveYieldStrategy.address, amount);

      await curveYieldStrategy.connect(user1).deposit(amount, user1.address);
      await hre.network.provider.send('evm_increaseTime', [10_000_000]);
      await hre.network.provider.send('evm_mine', []);

      await gauge.claimable_reward_write(curveYieldStrategy.address, addresses.CRV);
      await curveYieldStrategy.harvestFees();

      const price = (await curveYieldStrategy.getPriceX128()).toBigInt();
      const lpPrice = (await lpOracle.lp_price()).toBigInt();

      const diff = lpPrice - ((price * 10n ** 30n) >> 128n);
      expect(Number(diff)).to.be.oneOf([-1, 0, 1]);
    });

    it('total market value', async () => {});
  });

  describe('#fee', () => {
    it('should change fee within threshold', async () => {
      const [admin] = await hre.ethers.getSigners();
      const { curveYieldStrategyTest } = await curveYieldStrategyFixture();
      const curveYieldStrategy = curveYieldStrategyTest.connect(admin);

      await curveYieldStrategy.changeFee(2000);
      expect(await curveYieldStrategy.FEE()).to.be.eq(BigNumber.from(2000));
    });

    // uncomment when fixed from hardhat

    // it('should fail outside of threshold', async () => {
    //   const [admin] = await hre.ethers.getSigners();
    //   const { curveYieldStrategyTest } = await curveYieldStrategyFixture();
    //   const curveYieldStrategy = curveYieldStrategyTest.connect(admin);

    //   expect(await curveYieldStrategy.changeFee(10001)).to.be.revertedWith(revertReason('fee out of bounds'));
    // });
  });
});
