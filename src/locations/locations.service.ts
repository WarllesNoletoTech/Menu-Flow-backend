import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';

type State = { id: number; name: string; uf: string };
type City = { id: number; name: string };
type CacheEntry<T> = { expiresAt: number; value: T };
const IBGE = 'https://servicodados.ibge.gov.br/api/v1/localidades';
const CACHE_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class LocationsService {
  private statesCache?: CacheEntry<State[]>;
  private readonly cityCache = new Map<string, CacheEntry<City[]>>();

  states() { return this.cached(this.statesCache, async (value) => { this.statesCache = value; }, async () => {
    const data = await this.request<Array<{ id: number; nome: string; sigla: string }>>(`${IBGE}/estados?orderBy=nome`);
    return data.map(({ id, nome, sigla }) => ({ id, name: nome, uf: sigla }));
  }); }

  cities(ufInput: string) {
    const uf = ufInput.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(uf)) throw new BadRequestException('UF must contain exactly two letters');
    return this.cached(this.cityCache.get(uf), async (value) => { this.cityCache.set(uf, value); }, async () => {
      const states = await this.states();
      if (!states.some((state) => state.uf === uf)) throw new BadRequestException('Unknown Brazilian state');
      const data = await this.request<Array<{ id: number; nome: string }>>(`${IBGE}/estados/${uf}/municipios?orderBy=nome`);
      return data.map(({ id, nome }) => ({ id, name: nome }));
    });
  }

  private async cached<T>(entry: CacheEntry<T> | undefined, save: (entry: CacheEntry<T>) => Promise<void>, load: () => Promise<T>) {
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    const value = await load(); await save({ value, expiresAt: Date.now() + CACHE_MS }); return value;
  }
  private async request<T>(url: string): Promise<T> { try { const response = await fetch(url, { signal: AbortSignal.timeout(8000) }); if (!response.ok) throw new Error(String(response.status)); return await response.json() as T; } catch { throw new BadGatewayException('IBGE location service is temporarily unavailable'); } }
}
