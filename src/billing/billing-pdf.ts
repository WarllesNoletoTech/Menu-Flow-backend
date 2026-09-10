import { inflateSync, deflateSync } from "node:zlib";

type Report = {
  reportNumber: string;
  periodStart: Date | string;
  periodEnd: Date | string;
  generatedAt: Date | string;
  orderCount: number;
  serviceFeePerOrderCents: number;
  serviceFeeTotalCents: number;
  includeMonthlyFee: boolean;
  monthlyFeeCents: number;
  totalCents: number;
  timezone: string;
  restaurantSnapshot: Record<string, unknown>;
  paymentSnapshot?: { pixReceiverName?: string; pixKey?: string };
};
type Item = {
  orderNumber: string;
  completedAt: Date | string;
  fulfillment: string;
  orderTotalCents: number;
  feeCents: number;
};

export const normalizePdfText = (value: unknown) =>
  String(value ?? "").replace(/[\u00a0\u202f]/g, " ");
const money = (n: number) =>
  normalizePdfText(
    (n / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }),
  );
const date = (v: Date | string, tz: string) =>
  new Intl.DateTimeFormat("pt-BR", { timeZone: tz }).format(new Date(v));
const time = (v: Date | string, tz: string) =>
  normalizePdfText(
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(v)),
  );

// Helvetica Type1 consumes WinAnsi bytes, not UTF-8. This explicit encoder preserves
// Portuguese characters and escapes PDF string delimiters without ASCII transliteration.
const cp1252: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};
export function encodeWinAnsi(value: unknown) {
  const bytes: number[] = [];
  for (const char of normalizePdfText(value)) {
    const code = char.codePointAt(0)!;
    const byte = code <= 0xff ? code : cp1252[code];
    if (byte === undefined)
      throw new Error(
        `Caractere não suportado pela fonte WinAnsi: U+${code.toString(16).toUpperCase()}`,
      );
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) bytes.push(0x5c);
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

function pngRgb(png: Buffer) {
  if (png.subarray(1, 4).toString() !== "PNG")
    throw new Error("Logo não é PNG.");
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20),
    depth = png[24],
    color = png[25],
    interlace = png[28];
  if (depth !== 8 || color !== 2 || interlace !== 0)
    throw new Error("Formato PNG da logo não suportado.");
  const chunks: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at),
      kind = png.subarray(at + 4, at + 8).toString();
    if (kind === "IDAT") chunks.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks)),
    stride = width * 3,
    out = Buffer.alloc(stride * height);
  let source = 0;
  for (let row = 0; row < height; row++) {
    const filter = raw[source++];
    for (let x = 0; x < stride; x++) {
      const current = raw[source++],
        left = x >= 3 ? out[row * stride + x - 3] : 0,
        up = row ? out[(row - 1) * stride + x] : 0,
        upperLeft = row && x >= 3 ? out[(row - 1) * stride + x - 3] : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      else if (filter === 2) prediction = up;
      else if (filter === 3) prediction = Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upperLeft,
          pa = Math.abs(p - left),
          pb = Math.abs(p - up),
          pc = Math.abs(p - upperLeft);
        prediction = pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft;
      } else if (filter !== 0) throw new Error("Filtro PNG não suportado.");
      out[row * stride + x] = (current + prediction) & 255;
    }
  }
  return { width, height, data: deflateSync(out) };
}

export function renderBillingReportPdf(
  report: Report,
  items: Item[],
  logo?: Buffer,
) {
  const perPage = 22,
    pages = Math.max(1, Math.ceil(items.length / perPage));
  const objects: Array<Buffer | string> = [];
  const add = (v: Buffer | string) => {
    objects.push(v);
    return objects.length;
  };
  const font = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  const bold = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  );
  let imageId: number | undefined,
    imageSize: { width: number; height: number } | undefined;
  if (logo) {
    const image = pngRgb(logo);
    imageSize = image;
    imageId = add(
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.data.length} >>\nstream\n`,
        ),
        image.data,
        Buffer.from("\nendstream"),
      ]),
    );
  }
  const pageIds: number[] = [];
  const contents: number[] = [];
  for (let page = 0; page < pages; page++) {
    const rows = items.slice(page * perPage, (page + 1) * perPage);
    let y = 704;
    const out: Buffer[] = [];
    const raw = (s: string) => out.push(Buffer.from(s + "\n", "ascii"));
    const t = (x: number, yy: number, value: unknown, size = 9, b = false) => {
      out.push(
        Buffer.from(`BT /${b ? "B" : "F"} ${size} Tf ${x} ${yy} Td (`, "ascii"),
        encodeWinAnsi(value),
        Buffer.from(") Tj ET\n", "ascii"),
      );
    };
    const line = (yy: number) =>
      raw(`0.86 0.82 0.77 RG 42 ${yy} m 553 ${yy} l S`);
    raw("0.16 0.14 0.13 rg");
    if (imageId && imageSize) {
      const maxW = 125,
        maxH = 82,
        scale = Math.min(maxW / imageSize.width, maxH / imageSize.height);
      const w = imageSize.width * scale,
        h = imageSize.height * scale;
      raw(
        `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} 42 ${(748 - h / 2).toFixed(2)} cm /Logo Do Q`,
      );
    } else {
      t(42, 775, "Menu Flow", 20, true);
      t(42, 761, "Cardápios mais simples, clientes mais felizes.", 7);
    }
    raw("0.48 0.18 0.18 rg");
    t(315, 780, "RELATÓRIO DE SERVIÇOS", 18, true);
    raw("0.16 0.14 0.13 rg");
    if (page === 0) {
      t(42, y, `Relatório nº ${report.reportNumber}`, 11, true);
      t(330, y, `Emissão: ${date(report.generatedAt, report.timezone)}`, 9);
      y -= 18;
      t(
        42,
        y,
        `Empresa: ${report.restaurantSnapshot.tradeName || report.restaurantSnapshot.name}`,
        10,
        true,
      );
      t(
        330,
        y,
        `Período: ${date(report.periodStart, report.timezone)} a ${date(report.periodEnd, report.timezone)}`,
      );
      y -= 15;
      t(
        42,
        y,
        [
          report.restaurantSnapshot.cnpj,
          report.restaurantSnapshot.city,
          report.restaurantSnapshot.state,
        ]
          .filter(Boolean)
          .join(" | "),
      );
      y -= 22;
      line(y);
      y -= 22;
      t(42, y, "Taxa de desenvolvimento / serviço Menu Flow", 12, true);
      y -= 15;
      t(42, y, "Taxa referente aos pedidos concluídos no período.");
      y -= 18;
      t(42, y, `Pedidos concluídos: ${report.orderCount}`);
      t(210, y, `Valor unitário: ${money(report.serviceFeePerOrderCents)}`);
      t(410, y, `Subtotal: ${money(report.serviceFeeTotalCents)}`, 9, true);
      y -= 24;
    }
    t(42, y, "PEDIDO", 8, true);
    t(142, y, "DATA", 8, true);
    t(215, y, "HORA", 8, true);
    t(270, y, "MODALIDADE", 8, true);
    t(390, y, "VALOR DO PEDIDO", 8, true);
    t(500, y, "TAXA", 8, true);
    y -= 8;
    line(y);
    y -= 14;
    rows.forEach((i) => {
      t(42, y, i.orderNumber, 8);
      t(142, y, date(i.completedAt, report.timezone), 8);
      t(215, y, time(i.completedAt, report.timezone), 8);
      t(270, y, i.fulfillment === "DELIVERY" ? "Entrega" : "Retirada", 8);
      t(390, y, money(i.orderTotalCents), 8);
      t(500, y, money(i.feeCents), 8);
      y -= 17;
    });
    if (page === pages - 1) {
      y = Math.max(y - 10, 190);
      line(y);
      y -= 22;
      t(325, y, "Taxa de desenvolvimento", 10);
      t(485, y, money(report.serviceFeeTotalCents), 10, true);
      y -= 17;
      t(325, y, "Mensalidade Menu Flow", 10);
      t(
        485,
        y,
        report.includeMonthlyFee
          ? money(report.monthlyFeeCents)
          : "Não incluída",
        10,
        true,
      );
      y -= 27;
      raw("0.48 0.18 0.18 rg");
      t(325, y, "TOTAL A PAGAR", 14, true);
      t(475, y, money(report.totalCents), 14, true);
      raw("0.16 0.14 0.13 rg");
      y -= 34;
      line(y);
      y -= 19;
      t(42, y, "DADOS PARA PAGAMENTO", 11, true);
      y -= 16;
      t(42, y, "Pagamento via PIX", 9, true);
      y -= 15;
      t(
        42,
        y,
        `Favorecido: ${report.paymentSnapshot?.pixReceiverName || "Não informado"}`,
        9,
      );
      y -= 15;
      t(
        42,
        y,
        `Chave PIX: ${report.paymentSnapshot?.pixKey || "Não informada"}`,
        9,
      );
    }
    raw("0.16 0.14 0.13 rg");
    t(42, 43, "Menu Flow", 8, true);
    t(42, 31, "Cardápios mais simples, clientes mais felizes.", 7);
    t(425, 35, `${report.reportNumber} | Página ${page + 1} de ${pages}`, 8);
    const stream = Buffer.concat(out);
    contents.push(
      add(
        Buffer.concat([
          Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),
          stream,
          Buffer.from("endstream"),
        ]),
      ),
    );
    pageIds.push(add(""));
  }
  const pagesId = add("");
  pageIds.forEach(
    (id, n) =>
      (objects[id - 1] =
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F ${font} 0 R /B ${bold} 0 R >>${imageId ? ` /XObject << /Logo ${imageId} 0 R >>` : ""} >> /Contents ${contents[n]} 0 R >>`),
  );
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`;
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const chunks = [Buffer.from("%PDF-1.4\n%MENUFLOW\n")],
    offsets = [0];
  let offset = chunks[0].length;
  objects.forEach((obj, i) => {
    offsets.push(offset);
    const body = Buffer.isBuffer(obj) ? obj : Buffer.from(obj);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      body,
      Buffer.from("\nendobj\n"),
    ]);
    chunks.push(chunk);
    offset += chunk.length;
  });
  const xref = offset;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++)
    table += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  chunks.push(
    Buffer.from(
      `${table}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`,
    ),
  );
  return Buffer.concat(chunks);
}
