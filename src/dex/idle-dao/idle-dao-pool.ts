import { AbiItem } from 'web3-utils';
import { Contract } from 'web3-eth-contract';
import { Interface } from '@ethersproject/abi';
import { DeepReadonly } from 'ts-essentials';
import { Log, Logger } from '../../types';
import { catchParseLogError } from '../../utils';
import ERC20_ABI from '../../abi/erc20.json';
import CDO_ABI from '../../abi/idle-dao/idle-cdo.json';
import { StatefulEventSubscriber } from '../../stateful-event-subscriber';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { PoolState, IdleToken } from './types';

export class IdleDaoEventPool extends StatefulEventSubscriber<PoolState> {
  handlers: {
    [event: string]: (
      event: any,
      state: DeepReadonly<PoolState>,
      log: Readonly<Log>,
    ) => Promise<DeepReadonly<PoolState> | null>;
  } = {};

  logDecoder: (log: Log) => any;

  idleToken: IdleToken;
  cdoContract: Contract;
  poolInterface: Interface;
  addressesSubscribed: string[];

  constructor(
    readonly parentName: string,
    protected network: number,
    protected dexHelper: IDexHelper,
    logger: Logger,
    idleToken: IdleToken,
  ) {
    // TODO: Add pool name
    super(parentName, idleToken.idleSymbol, dexHelper, logger);

    this.poolInterface = new Interface(ERC20_ABI);

    // TODO: make logDecoder decode logs that
    this.logDecoder = (log: Log) => this.poolInterface.parseLog(log);
    this.addressesSubscribed = [idleToken.idleAddress];

    // Add handlers
    this.handlers['Transfer'] = this.handleCoinTransfer.bind(this);

    this.idleToken = idleToken;
    this.cdoContract = new dexHelper.web3Provider.eth.Contract(
      CDO_ABI as AbiItem[],
      this.idleToken.cdoAddress,
    );
  }

  /**
   * The function is called every time any of the subscribed
   * addresses release log. The function accepts the current
   * state, updates the state according to the log, and returns
   * the updated state.
   * @param state - Current state of event subscriber
   * @param log - Log released by one of the subscribed addresses
   * @returns Updates state of the event subscriber after the log
   */
  protected async processLog(
    state: DeepReadonly<PoolState>,
    log: Readonly<Log>,
  ): Promise<DeepReadonly<PoolState> | null> {
    try {
      const event = this.logDecoder(log);
      if (event.name in this.handlers) {
        const result = await this.handlers[event.name](event, state, log);
        return result;
      }
    } catch (e) {
      catchParseLogError(e, this.logger);
    }

    return null;
  }

  /**
   * The function generates state using on-chain calls. This
   * function is called to regenerate state if the event based
   * system fails to fetch events and the local state is no
   * more correct.
   * @param blockNumber - Blocknumber for which the state should
   * should be generated
   * @returns state of the event subscriber at blocknumber
   */
  async generateState(blockNumber: number): Promise<DeepReadonly<PoolState>> {
    const tranchePrice = await this.cdoContract.methods['virtualPrice'](
      this.idleToken.idleAddress,
    ).call({}, blockNumber);
    // this.logger.debug('generateState', blockNumber, this.idleToken.idleSymbol, tranchePrice)
    return {
      tokenPrice: BigInt(tranchePrice),
    };
  }

  async handleCoinTransfer(
    event: any,
    state: PoolState,
    log: Log,
  ): Promise<DeepReadonly<PoolState> | null> {
    const result = await this.generateState(log.blockNumber);
    // this.logger.debug('handleCoinTransfer', log.blockNumber, this.idleToken.idleSymbol, result)
    return result;
  }
}
