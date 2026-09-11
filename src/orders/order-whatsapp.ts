import { BadRequestException } from "@nestjs/common";

export type WhatsAppOrder = {
  orderNumber?: string;
  customerName: string;
  phone: string;
  fulfillment: string;
  address?: Record<string, string>;
  paymentMethod: string;
  needsChange: boolean;
  changeForCents?: number;
  subtotalCents: number;
  deliveryFeeCents: number;
  customerServiceFeeCents?: number;
  discountCents: number;
  totalCents: number;
  items: Array<{
    productName: string;
    quantity: number;
    observation?: string;
    addons: Array<{ name: string }>;
  }>;
};

export function normalizeBrazilianWhatsApp(value?: string) {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^[\d\s()+.-]+$/.test(value))
    throw new BadRequestException(
      "WhatsApp para pedidos deve conter somente um número de telefone.",
    );
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("0")) digits = digits.slice(1);
  if (!digits.startsWith("55")) digits = `55${digits}`;
  if (!/^55\d{10,11}$/.test(digits))
    throw new BadRequestException(
      "Informe um WhatsApp brasileiro válido com DDD.",
    );
  return digits;
}

export const normalizeWhatsAppText = (value: string) =>
  value
    .normalize("NFC")
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/\r\n?/g, "\n")
    .trim();

const money = (cents: number) =>
  normalizeWhatsAppText(
    (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }),
  );
const payment: Record<string, string> = {
  PIX: "Pix",
  CASH: "Dinheiro",
  CREDIT_CARD: "Cartão de crédito",
  DEBIT_CARD: "Cartão de débito",
};

export function buildOrderWhatsAppMessage(
  order: WhatsAppOrder,
  restaurant: {
    address?: string;
    city?: string;
    state?: string;
    mapUrl?: string;
  },
  trackingUrl?: string,
) {
  const lines = [
    "NOVO PEDIDO - MENU FLOW",
    "",
    `Pedido: ${order.orderNumber}`,
    `Cliente: ${order.customerName}`,
    `Telefone: ${order.phone}`,
    "",
    "Itens:",
    "",
  ];
  for (const item of order.items) {
    lines.push(`${item.quantity}x ${item.productName}`);
    item.addons.forEach((addon) => lines.push(`- ${addon.name}`));
    if (item.observation) lines.push(`Observação: ${item.observation}`);
    lines.push("");
  }
  if (order.fulfillment === "DELIVERY") {
    const address = order.address ?? {};
    lines.push(
      "Modalidade: Entrega",
      "",
      "Endereço:",
      `${address.street ?? ""}, ${address.number ?? ""}`,
      `Bairro ${address.neighborhood ?? ""}`,
    );
    if (address.complement) lines.push(`Complemento: ${address.complement}`);
    lines.push(
      `${address.city ?? ""} - ${address.state ?? ""}`,
      `CEP ${address.zipCode ?? ""}`,
    );
    if (address.reference) lines.push(`Referência: ${address.reference}`);
  } else {
    lines.push("Modalidade: Retirada no estabelecimento");
    if (restaurant.address)
      lines.push("", "Endereço da loja:", restaurant.address);
    if (restaurant.city || restaurant.state)
      lines.push(
        [restaurant.city, restaurant.state].filter(Boolean).join(" - "),
      );
    if (restaurant.mapUrl) lines.push(`Localização: ${restaurant.mapUrl}`);
  }
  lines.push(
    "",
    `Pagamento: ${payment[order.paymentMethod] ?? order.paymentMethod}`,
  );
  if (
    order.paymentMethod === "CASH" &&
    order.needsChange &&
    order.changeForCents
  )
    lines.push(`Troco para: ${money(order.changeForCents)}`);
  lines.push(
    "",
    `Subtotal: ${money(order.subtotalCents)}`,
    `Taxa de entrega: ${money(order.deliveryFeeCents)}`,
    `Taxa de serviço Menu Flow: ${money(order.customerServiceFeeCents ?? 0)}`,
  );
  if (order.discountCents)
    lines.push(`Desconto: -${money(order.discountCents)}`);
  lines.push(
    `Total pago pelo cliente: ${money(order.totalCents)}`,
    "",
    "Status: Aguardando aceitação.",
  );
  if (trackingUrl) lines.push("", "Acompanhar pedido:", trackingUrl);
  lines.push("", "O status oficial do pedido é atualizado pelo Menu Flow.");
  return normalizeWhatsAppText(lines.join("\n"));
}

export function buildWhatsAppUrl(number: string | undefined, message: string) {
  return number
    ? `https://wa.me/${number}?text=${encodeURIComponent(normalizeWhatsAppText(message))}`
    : undefined;
}
