import { DexParams } from './types';
import { DexConfigMap, AdapterMappings } from '../../types';
import { Network, SwapSide } from '../../constants';

export const DexalotConfig: DexConfigMap<DexParams> = {
  Dexalot: {
    [Network.AVALANCHE]: {
      mainnetRFQAddress: '0xEed3c159F3A96aB8d41c8B9cA49EE1e5071A7cdD',
    },
    [Network.ARBITRUM]: {
      mainnetRFQAddress: '0x010224949cCa211Fb5dDfEDD28Dc8Bf9D2990368',
    },
  },
};

export const Adapters: Record<number, AdapterMappings> = {
  [Network.AVALANCHE]: {
    [SwapSide.SELL]: [{ name: 'AvalancheAdapter02', index: 6 }],
    [SwapSide.BUY]: [{ name: 'AvalancheBuyAdapter', index: 8 }],
  },
};
