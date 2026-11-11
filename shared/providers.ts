import type { ProviderConfig } from './types';
export const isCustomProvider = (p: Pick<ProviderConfig, 'id'>) => p.id === 'custom' || p.id.startsWith('custom-');
export const piProviderId = (p: Pick<ProviderConfig, 'id'>) => isCustomProvider(p) ? `saint-${p.id}` : p.id;
export const customKeyName = (p: Pick<ProviderConfig, 'id'>) => p.id === 'custom' ? 'SAINT_CUSTOM_API_KEY' : `SAINT_${p.id.replace(/-/g, '_').toUpperCase()}_API_KEY`;
