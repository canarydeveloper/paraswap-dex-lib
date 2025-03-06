import {
  Token,
  Address,
  ExchangePrices,
  PoolPrices,
  AdapterExchangeParam,
  PoolLiquidity,
  DexExchangeParam,
  NumberAsString,
} from '../../types';
import {
  SwapSide,
  Network,
  FETCH_POOL_IDENTIFIER_TIMEOUT,
  ETHER_ADDRESS,
} from '../../constants';
import * as CALLDATA_GAS_COST from '../../calldata-gas-cost';
import { getBigIntPow, getDexKeysWithNetwork } from '../../utils';
import { Context, IDex } from '../../dex/idex';
import { IDexHelper } from '../../dex-helper/idex-helper';
import {
  EkuboData,
  GetQuoteDataResponse,
  PoolConfig,
  PoolKey,
  PoolState,
  VanillaPoolParameters,
} from './types';
import { SimpleExchange } from '../simple-exchange';
import { EkuboConfig } from './config';
import { BasePool, BasePool as EkuboEventPool } from './pools/base-pool';
import {
  convertEkuboToParaSwap,
  convertParaSwapToEkubo,
  hexStringTokenPair,
  NATIVE_TOKEN_ADDRESS,
  sortAndConvertTokens,
} from './utils';
import Joi from 'joi';
import { Interface } from '@ethersproject/abi';

import CoreABI from '../../abi/ekubo/core.json';
import DataFetcherABI from '../../abi/ekubo/data-fetcher.json';
import { BigNumber, Contract } from 'ethers';
import { setTimeout } from 'node:timers/promises';
import { FULL_RANGE_TICK_SPACING } from './pools/math/tick';
import { hexlify } from 'ethers/lib/utils';
import RouterABI from '../../abi/ekubo/router.json';
import { isPriceIncreasing } from './pools/math/swap';
import { OraclePool } from './pools/oracle-pool';
import { erc20Iface } from '../../lib/tokens/utils';
import { AsyncOrSync } from 'ts-essentials';
import { MAX_SQRT_RATIO_FLOAT, MIN_SQRT_RATIO_FLOAT } from './pools/math/price';
import { MIN_I256 } from './pools/math/constants';

const FALLBACK_POOL_PARAMETERS: VanillaPoolParameters[] = [
  {
    fee: 1844674407370955n,
    tickSpacing: 200,
  },
  {
    fee: 9223372036854775n,
    tickSpacing: 1000,
  },
  {
    fee: 55340232221128654n,
    tickSpacing: 5982,
  },
  {
    fee: 184467440737095516n,
    tickSpacing: 19802,
  },
  {
    fee: 922337203685477580n,
    tickSpacing: 95310,
  },
];

type PairInfo = {
  fee: string;
  tick_spacing: number;
  core_address: string;
  extension: string;
  tvl0_total: string;
  tvl1_total: string;
};

const tokenPairSchema = Joi.object<{
  topPools: PairInfo[];
}>({
  topPools: Joi.array().items(
    Joi.object({
      fee: Joi.string(),
      tick_spacing: Joi.number(),
      extension: Joi.string(),
      tvl0_total: Joi.string(),
      tvl1_total: Joi.string(),
    }),
  ),
});

const topPairsSchema = Joi.object<{
  topPairs: {
    token0: string;
    token1: string;
    tvl0_total: string;
    tvl1_total: string;
  }[];
}>({
  topPairs: Joi.array().items(
    Joi.object({
      token0: Joi.string(),
      token1: Joi.string(),
      tvl0_total: Joi.string(),
      tvl1_total: Joi.string(),
    }),
  ),
});

const allPoolsSchema = Joi.array<
  {
    core_address: string;
    token0: string;
    token1: string;
    fee: string;
    tick_spacing: number;
    extension: string;
  }[]
>().items(
  Joi.object({
    core_address: Joi.string(),
    token0: Joi.string(),
    token1: Joi.string(),
    fee: Joi.string(),
    tick_spacing: Joi.number(),
    extension: Joi.string(),
  }),
);

const MIN_TICK_SPACINGS_PER_POOL = 10;
const MAX_POOL_BATCH_COUNT = 5;

const POOL_MAP_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

// Ekubo Protocol https://ekubo.org/
export class Ekubo extends SimpleExchange implements IDex<EkuboData> {
  protected readonly eventPools: Record<string, EkuboEventPool> = {};

  public readonly hasConstantPriceLargeAmounts = false;
  public readonly needWrapNative = false;
  public readonly isFeeOnTransferSupported = false;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(EkuboConfig);

  private readonly pools: Map<string, BasePool> = new Map();

  public logger;

  public readonly config;
  public readonly routerIface;

  private readonly core;
  private readonly coreIface;
  private readonly dataFetcher;
  private readonly supportedExtensions;

  private interval?: NodeJS.Timeout;

  private readonly decimals: Record<string, number> = {
    [ETHER_ADDRESS]: 18,
  };

  public constructor(
    readonly network: Network,
    readonly dexKey: string,
    readonly dexHelper: IDexHelper,
  ) {
    super(dexHelper, dexKey);

    this.logger = dexHelper.getLogger(dexKey);
    this.config = EkuboConfig[dexKey][network];
    this.core = new Contract(this.config.core, CoreABI, dexHelper.provider);
    this.coreIface = new Interface(CoreABI);
    this.dataFetcher = new Contract(
      this.config.dataFetcher,
      DataFetcherABI,
      dexHelper.provider,
    );
    this.routerIface = new Interface(RouterABI);
    this.supportedExtensions = [0n, BigInt(this.config.oracle)];
  }

  public async initializePricing(blockNumber: number) {
    await this.updatePoolMap(blockNumber);

    this.interval = setInterval(async () => {
      await this.updatePoolMap(await this.dexHelper.provider.getBlockNumber());
    }, POOL_MAP_UPDATE_INTERVAL_MS);
  }

  // Legacy: was only used for V5
  // Returns the list of contract adapters (name and index)
  // for a buy/sell. Return null if there are no adapters.
  public getAdapters(
    _side: SwapSide,
  ): { name: string; index: number }[] | null {
    return null;
  }

  // Returns list of pool identifiers that can be used
  // for a given swap. poolIdentifiers must be unique
  // across DEXes. It is recommended to use
  // ${dexKey}_${poolAddress} as a poolIdentifier
  public async getPoolIdentifiers(
    srcToken: Token,
    destToken: Token,
    _side: SwapSide,
    blockNumber: number,
  ): Promise<string[]> {
    return this.fetchPoolsByPair(
      srcToken,
      destToken,
      blockNumber,
      FETCH_POOL_IDENTIFIER_TIMEOUT,
    );
  }

  // Returns pool prices for amounts.
  // If limitPools is defined only pools in limitPools
  // should be used. If limitPools is undefined then
  // any pools can be used.
  public async getPricesVolume(
    srcToken: Token,
    destToken: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    limitPools?: string[],
  ): Promise<null | ExchangePrices<EkuboData>> {
    const pools = this.getInitializedPools(srcToken, destToken, limitPools);

    const isExactOut = side === SwapSide.BUY;

    const amountToken = isExactOut ? destToken : srcToken;
    const amountTokenAddress = convertParaSwapToEkubo(amountToken.address);
    const unitAmount = getBigIntPow(amountToken.decimals);

    const [token0, token1] = sortAndConvertTokens(srcToken, destToken);

    const exchangePrices = [];

    // eslint-disable-next-line no-restricted-syntax
    poolLoop: for (const pool of pools) {
      const poolId = pool.key.string_id;

      if (pool.key.token0 !== token0 || pool.key.token1 !== token1) {
        this.logger.error(
          `Can't quote pair ${hexStringTokenPair(
            token0,
            token1,
          )} on pool ${poolId}`,
        );
        continue;
      }

      try {
        const quotes = [];
        const skipAheadMap: Map<bigint, number> = new Map();

        for (const amount of [unitAmount, ...amounts]) {
          const inputAmount = isExactOut ? -amount : amount;

          const quote = pool.quote(
            inputAmount,
            amountTokenAddress,
            blockNumber,
          );

          if (isExactOut && quote.consumedAmount !== inputAmount) {
            this.logger.debug(
              "Pool doesn't have enough liquidity to support exact-out swap",
            );

            // There doesn't seem to be a way to skip just this one price.
            // Anyway, this pool is probably not the right one if it has such thin liquidity.
            continue poolLoop;
          }

          quotes.push(quote);
          skipAheadMap.set(amount, quote.skipAhead);
        }

        const [unitQuote, ...otherQuotes] = quotes;

        exchangePrices.push({
          prices: otherQuotes.map(quote => quote.calculatedAmount),
          unit: unitQuote.calculatedAmount,
          data: {
            poolKey: pool.key,
            isToken1: amountTokenAddress === token1,
            skipAhead: skipAheadMap,
          },
          poolIdentifier: poolId,
          exchange: this.dexKey,
          gasCost: otherQuotes.map(quote => quote.gasConsumed),
        });
      } catch (err) {
        this.logger.error('Quote error:', err);
        continue;
      }
    }

    return exchangePrices;
  }

  // Returns estimated gas cost of calldata for this DEX in multiSwap
  public getCalldataGasCost(
    _poolPrices: PoolPrices<EkuboData>,
  ): number | number[] {
    return CALLDATA_GAS_COST.DEX_NO_PAYLOAD;
  }

  // V6: Not used, can be left blank
  public getAdapterParam(
    _srcToken: string,
    _destToken: string,
    _srcAmount: string,
    _destAmount: string,
    _data: EkuboData,
    _side: SwapSide,
  ): AdapterExchangeParam {
    return {
      targetExchange: this.dexKey,
      payload: '',
      networkFee: '0',
    };
  }

  public async updatePoolState(): Promise<void> {}

  // Returns list of top pools based on liquidity. Max
  // limit number pools should be returned.
  public async getTopPoolsForToken(
    tokenAddress: Address,
    limit: number,
  ): Promise<PoolLiquidity[]> {
    const topPairsUrl = `${this.config.apiUrl}/overview/pairs`;
    const topPairsRes = await this.dexHelper.httpRequest.get(topPairsUrl);

    const { error, value } = topPairsSchema.validate(topPairsRes, {
      allowUnknown: true,
      presence: 'required',
    });

    if (typeof error !== 'undefined') {
      throw new Error(`validating API response from ${topPairsUrl}: ${error}`);
    }

    const poolLiquidities: PoolLiquidity[] = [];

    await Promise.allSettled(
      value.topPairs.map(pair =>
        (async () => {
          if (pair.tvl0_total === '0' && pair.tvl1_total === '0') {
            return;
          }

          const tokenPair = [BigInt(pair.token0), BigInt(pair.token1)];
          const [token0, token1] = tokenPair;

          if (!tokenPair.includes(convertParaSwapToEkubo(tokenAddress))) {
            return;
          }

          const poolsInfo = await this.fetchPairPoolsInfo(
            hexStringTokenPair(token0, token1),
          );

          for (const poolInfo of poolsInfo) {
            const [info0, info1] = await Promise.all(
              tokenPair.map((ekuboToken, i) =>
                (async () => {
                  const paraswapToken = convertEkuboToParaSwap(ekuboToken);
                  const decimals = await this.getDecimals(paraswapToken);

                  const token = {
                    address: paraswapToken,
                    decimals,
                  };

                  return {
                    token,
                    tvl: await this.dexHelper.getTokenUSDPrice(
                      token,
                      BigInt(poolInfo[`tvl${i as 0 | 1}_total`]),
                    ),
                  };
                })(),
              ),
            );

            poolLiquidities.push({
              exchange: this.dexKey,
              address: this.config.core,
              connectorTokens: [
                (info0.token.address !== tokenAddress ? info0 : info1).token,
              ],
              liquidityUSD: info0.tvl + info1.tvl,
            });
          }
        })(),
      ),
    );

    poolLiquidities
      .sort((a, b) => b.liquidityUSD - a.liquidityUSD)
      .splice(limit, Infinity);

    return poolLiquidities;
  }

  private async getDecimals(paraswapToken: string): Promise<number> {
    const cached = this.decimals[paraswapToken];
    if (typeof cached === 'number') {
      return cached;
    }

    const decimals: number = await new Contract(
      paraswapToken,
      erc20Iface,
      this.dexHelper.provider,
    ).decimals();

    this.decimals[paraswapToken] = decimals;

    return decimals;
  }

  public getDexParam(
    _srcToken: Address,
    _destToken: Address,
    srcAmount: NumberAsString,
    destAmount: NumberAsString,
    recipient: Address,
    data: EkuboData,
    side: SwapSide,
    _context: Context,
    _executorAddress: Address,
  ): DexExchangeParam {
    const amount = BigInt(side === SwapSide.BUY ? `-${destAmount}` : srcAmount);

    return {
      needWrapNative: this.needWrapNative,
      exchangeData: this.routerIface.encodeFunctionData(
        'swap((address,address,bytes32),bool,int128,uint96,uint256,int256,address)',
        [
          data.poolKey.toAbi(),
          data.isToken1,
          BigNumber.from(amount),
          isPriceIncreasing(amount, data.isToken1)
            ? MAX_SQRT_RATIO_FLOAT
            : MIN_SQRT_RATIO_FLOAT,
          BigNumber.from(
            data.skipAhead.get(
              BigInt(side === SwapSide.SELL ? srcAmount : destAmount),
            ) ?? 0,
          ),
          MIN_I256,
          recipient,
        ],
      ),
      targetExchange: this.config.router,
      dexFuncHasRecipient: true,
      returnAmountPos: undefined,
    };
  }

  releaseResources(): AsyncOrSync<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  private getInitializedPools(
    tokenA: Token,
    tokenB: Token,
    limitPools: string[] | undefined,
  ): BasePool[] {
    if (typeof limitPools === 'undefined') {
      const [token0, token1] = sortAndConvertTokens(tokenA, tokenB);

      return Array.from(
        this.pools
          .values()
          .filter(
            pool => pool.key.token0 === token0 && pool.key.token1 === token1,
          ),
      );
    }

    return limitPools.flatMap(poolId => {
      const pool = this.pools.get(poolId);

      if (typeof pool === 'undefined') {
        this.logger.warn(`Pool ${poolId} requested but not found`);
        return [];
      }

      return [pool];
    });
  }

  private async updatePoolMap(blockNumber: number) {
    let poolKeys: PoolKey[];
    try {
      poolKeys = await this.fetchAllPoolKeys();
    } catch (err) {
      this.logger.error(`Updating pool map from Ekubo API failed: ${err}`);

      return;
    }

    const uninitializedPoolKeys = poolKeys.filter(
      poolKey => !this.pools.has(poolKey.string_id),
    );
    const promises = await this.initializePools(
      uninitializedPoolKeys,
      blockNumber,
      undefined,
    );

    (await Promise.allSettled(promises)).flatMap(res => {
      if (res.status === 'rejected') {
        this.logger.error(
          `Fetching batch failed. Pool keys: ${res.reason.batch}. Error: ${res.reason.err}`,
        );
      }
    });
  }

  private async fetchPoolsByPair(
    tokenA: Token,
    tokenB: Token,
    blockNumber: number,
    maxTime: number,
  ): Promise<string[]> {
    const [token0, token1] = sortAndConvertTokens(tokenA, tokenB);
    const pair = hexStringTokenPair(token0, token1);

    // Leave some time for computations & timer inaccuracies
    maxTime -= 50;

    let poolKeys: PoolKey[];
    try {
      poolKeys = (await this.fetchAllPoolKeys()).filter(
        poolKey => poolKey.token0 === token0 && poolKey.token1 === token1,
      );
    } catch (err) {
      this.logger.error(
        `Fetching pools from Ekubo API for token pair ${pair} failed, falling back to default pool parameters: ${err}`,
      );

      poolKeys = FALLBACK_POOL_PARAMETERS.map(
        params =>
          new PoolKey(
            token0,
            token1,
            new PoolConfig(params.tickSpacing, params.fee, 0n),
          ),
      );

      if ([token0, token1].includes(NATIVE_TOKEN_ADDRESS)) {
        poolKeys.push(
          new PoolKey(
            token0,
            token1,
            new PoolConfig(
              FULL_RANGE_TICK_SPACING,
              0n,
              BigInt(this.config.oracle),
            ),
          ),
        );
      }
    }

    const uninitializedPoolKeys: PoolKey[] = [];
    const initializedPoolKeys: PoolKey[] = [];

    for (const poolKey of poolKeys) {
      (this.pools.has(poolKey.string_id)
        ? initializedPoolKeys
        : uninitializedPoolKeys
      ).push(poolKey);
    }

    const promises = await this.initializePools(
      uninitializedPoolKeys,
      blockNumber,
      maxTime / 2,
    );

    const oldPoolIds = initializedPoolKeys.map(poolKey => poolKey.string_id);
    const newPoolIds = (await Promise.allSettled(promises)).flatMap(res => {
      if (res.status === 'rejected') {
        this.logger.error(
          `Fetching batch failed. Pool keys: ${res.reason.batch}. Error: ${res.reason.err}`,
        );
        return [];
      } else {
        return res.value;
      }
    });

    return oldPoolIds.concat(newPoolIds);
  }

  private async initializePools(
    poolKeys: PoolKey[],
    blockNumber: number,
    maxTime: number | undefined,
  ) {
    const promises = [];

    for (
      let batchStart = 0;
      batchStart < poolKeys.length;
      batchStart += MAX_POOL_BATCH_COUNT
    ) {
      const batch = poolKeys.slice(
        batchStart,
        batchStart + MAX_POOL_BATCH_COUNT,
      );

      promises.push(
        Promise.race([
          ...(maxTime
            ? [
                setTimeout(maxTime).then(() => {
                  throw new Error('Timeout');
                }),
              ]
            : []),
          (async () => {
            const fetchedData: GetQuoteDataResponse =
              await this.dataFetcher.getQuoteData(
                batch.map(poolKey => poolKey.toAbi()),
                MIN_TICK_SPACINGS_PER_POOL,
                {
                  blockTag: blockNumber,
                },
              );

            return Promise.all(
              fetchedData.map(async (data, i) => {
                const initialState = PoolState.fromQuoter(data);

                const poolKey = poolKeys[batchStart + i];
                const poolId = poolKey.string_id;
                const extension = poolKey.config.extension;

                let poolConstructor;
                if (extension === 0n) {
                  poolConstructor = BasePool;
                } else if (extension === BigInt(this.config.oracle)) {
                  poolConstructor = OraclePool;
                } else {
                  throw new Error(
                    `Unknown pool extension ${hexlify(extension)}`,
                  );
                }

                const pool = new poolConstructor(
                  this.dexKey,
                  this.network,
                  this.dexHelper,
                  this.logger,
                  this.coreIface,
                  this.dataFetcher,
                  poolKey,
                  this.core,
                );

                this.pools.set(poolId, pool);

                // This is fulfilled immediately
                await pool.initialize(blockNumber, { state: initialState });

                return poolId;
              }),
            );
          })(),
        ]).catch(err => {
          throw {
            batch,
            err,
          };
        }),
      );
    }

    return promises;
  }

  private async fetchAllPoolKeys(): Promise<PoolKey[]> {
    const res = await this.dexHelper.httpRequest.get(
      `${this.config.apiUrl}/pools`,
    );

    const { error, value } = allPoolsSchema.validate(res, {
      allowUnknown: true,
      presence: 'required',
    });

    if (typeof error !== 'undefined') {
      throw new Error(`validating API response: ${error}`);
    }

    return value
      .filter(
        res =>
          this.supportedExtensions.includes(BigInt(res.extension)) &&
          BigInt(res.core_address) === BigInt(this.core.address),
      )
      .map(
        info =>
          new PoolKey(
            BigInt(info.token0),
            BigInt(info.token1),
            new PoolConfig(
              info.tick_spacing,
              BigInt(info.fee),
              BigInt(info.extension),
            ),
          ),
      );
  }

  private async fetchPairPoolsInfo(pair: string): Promise<PairInfo[]> {
    const res = await this.dexHelper.httpRequest.get(
      `${this.config.apiUrl}/pair/${pair}/pools`,
    );

    const { error, value } = tokenPairSchema.validate(res, {
      allowUnknown: true,
      presence: 'required',
    });

    if (typeof error !== 'undefined') {
      throw new Error(`validating API response: ${error}`);
    }

    return value.topPools.filter(
      res =>
        this.supportedExtensions.includes(BigInt(res.extension)) &&
        BigInt(this.core.address) === BigInt(res.core_address) &&
        (res.tvl0_total !== '0' || res.tvl1_total !== '0'),
    );
  }
}
