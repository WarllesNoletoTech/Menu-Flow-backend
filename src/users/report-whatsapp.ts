import { BadRequestException } from '@nestjs/common';

export function normalizeReportWhatsapp(value?: string): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  if (!/^[\d\s()+.-]+$/.test(value)) throw new BadRequestException('WhatsApp para relatórios inválido. Informe apenas o número brasileiro.');
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (!digits.startsWith('55')) digits = `55${digits}`;
  if (!/^55\d{10,11}$/.test(digits)) throw new BadRequestException('WhatsApp para relatórios inválido. Use DDD e número com 10 ou 11 dígitos.');
  return digits;
}
