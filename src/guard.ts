// Purchase guard: Ghostwright does not place orders, pay, subscribe, donate
// or start paid trials unless allowPurchases is true. It runs below the
// model: a click (by id, or by point, also inside a frame), a check, Enter
// or Space anywhere in a key sequence, a newline in typed text, or a
// submit of a form whose submit control buys or that holds card fields is
// refused, whoever chose the action (a model, do(), or a replayed flow).
// "Add to cart" and "Proceed to checkout" pass.

// Phrases that commit money. Written plainly; matched after normaliseLabel.
const PHRASES = [
  // English
  "place (your |my |the )?order", "place order", "submit (your |my )?order", "order now", "order and pay",
  "order with obligation to pay", "complete (your |my |the )?(order|purchase|payment)", "complete and pay",
  "confirm (and|to) pay", "confirm (your |my |the )?(order|purchase|payment|booking|subscription)",
  "buy now", "buy it now", "buy with 1 ?click", "1 ?click buy", "one ?click buy", "commit to buy",
  "pay now", "pay (with|by) ", "pay \\S*\\d", "make (a )?payment", "purchase now", "complete checkout", "finish (your )?purchase",
  "book now", "book and pay", "reserve and pay", "rent now", "place (a |your )?bid", "bid now",
  "subscribe", "start (your |my |a )?(\\d+ ?days? )?(free )?trial", "\\d+ ?days? free trial", "try (it )?free",
  "upgrade( now| to| your| plan| account)", "get premium", "go premium", "get pro", "go pro",
  "renew( now| membership| subscription| plan)", "donate", "give now",
  "(join|try|get|start) (amazon )?prime", "start (your |my )?membership", "sign up for (amazon )?prime",
  // German
  "jetzt kaufen", "zahlungspflichtig bestellen", "kostenpflichtig bestellen", "bestellung (aufgeben|abschicken|abschliessen|absenden)",
  "jetzt bezahlen", "kaufen und bezahlen", "jetzt bestellen", "abonnieren", "gratis testen", "probemonat", "kostenlos testen",
  "mitglied werden", "jetzt spenden", "jetzt buchen",
  // French
  "acheter maintenant", "payer maintenant", "valider (la |ma |votre )?commande", "confirmer (la |ma )?commande",
  "confirmer et payer", "commander maintenant", "commande avec obligation de paiement", "s abonner", "essai gratuit",
  "payer \\S*\\d", "reserver maintenant", "faire un don",
  // Spanish
  "realizar (el |tu )?pedido", "comprar ahora", "pagar ahora", "confirmar (el )?pedido", "confirmar (la )?compra",
  "confirmar y pagar", "finalizar pedido", "pedido con obligacion de pago", "suscribirse", "suscribete", "prueba gratis",
  "reservar ahora", "donar",
  // Italian
  "acquista ora", "effettua (l )?ordine", "conferma (l )?ordine", "conferma e paga", "paga ora", "ordine con obbligo di pagamento",
  "abbonati", "prova gratis", "prenota ora", "dona ora",
  // Portuguese
  "comprar agora", "fazer (o )?pedido", "finalizar (o )?pedido", "pagar agora", "confirmar e pagar", "assinar agora", "teste gratis",
  "encomenda com obrigacao de pagamento",
  // Dutch
  "bestelling plaatsen", "nu kopen", "nu betalen", "bestellen en betalen", "bestelling met betalingsverplichting", "abonneren", "gratis proberen",
  // Polish
  "kupuje i place", "zamawiam z obowiazkiem zaplaty", "zamow i zaplac", "kup teraz", "zaplac", "potwierdzam zakup", "zamawiam",
  // Swedish
  "kop nu", "betala nu", "slutfor kop", "slutfor (din )?bestallning", "bekrafta (kop|bestallning)", "bestall nu", "lagg bestallning",
  // Turkish
  "siparisi onayla", "siparisi tamamla", "satin al", "simdi satin al", "simdi ode", "odeme yap", "abone ol",
  // Russian
  "оформить заказ", "подтвердить заказ", "оплатить", "купить сейчас", "купить в 1 клик", "оформить подписку", "подписаться",
  // Chinese
  "提交订单", "立即购买", "确认订单", "确认支付", "立即支付", "去支付", "立即下单", "马上购买", "订阅", "提交訂單", "立即購買", "確認訂單", "立即付款",
  // Japanese
  "注文を確定", "注文する", "購入する", "今すぐ購入", "今すぐ買う", "支払う", "お支払い", "注文確定", "購入手続き", "定期購入",
  // Korean
  "주문하기", "결제하기", "구매하기", "바로구매", "주문 완료", "구독하기",
];

// Labels that buy when they are the whole label of a submit control.
const EXACT_SUBMIT = /^ (confirm|checkout|check out|order|pay|purchase|buy|subscribe|bestellen|kaufen|commander|comprar|acquista|kopen|kup|kop|заказать|купить|购买|结算|購入|注文|결제|구매) $/;

// Form actions of order, payment and subscription forms.
const ACTION_RE = /(^|[/._-])(order|orders|checkout|purchase|payment|pay|buy|subscribe|subscription|billing|donate)([/._?-]|$)/i;

// ids and names stores give the final button
const ID_RE = /place.?(your.?)?order|submit.?order|buy.?now|one.?click|1.?click|turbo.?checkout|pay.?now|complete.?(order|purchase)|confirm.?(and.?)?pay|subscribe|free.?trial|checkout.?pay/i;

// labels that look close but do not buy
const SAFE_RE = / (add to (cart|basket|bag|list|wish ?list)|proceed to checkout|go to checkout|checkout now|view cart|buy again|in den warenkorb|zur kasse|ajouter au panier|a[nñ]adir (a la|al) (cesta|carrito)|aggiungi al carrello|adicionar ao carrinho|in winkelwagen|unsubscribe|abmelden|se desabonner|desuscribirse|abonnement kundigen|cancel (my |your )?subscription|加入购物车|カートに入れる|장바구니) /;

const MAX_LABEL = 90; // longer text is a container, not a control's label

/** No accents (Hangul and kana kept whole). Letter case is left alone. */
function fold(text: string): string {
  const t = String(text || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").normalize("NFC");
  return t.replace(/ß/g, "ss").replace(/ł/g, "l").replace(/ı/g, "i").replace(/ø/g, "o").replace(/æ/g, "ae");
}

/** Lower case, no accents, punctuation to spaces, padded with spaces. */
export function normaliseLabel(text: string): string {
  const t = fold(String(text || "").toLowerCase().replace(/&/g, " and ")).replace(/[^\p{L}\p{N}$€£¥₩₽]+/gu, " ");
  return " " + t.replace(/\s+/g, " ").trim() + " ";
}

// the phrases are lower-case regular expressions: fold accents only, keep the syntax
const PHRASE_RE = new RegExp("(?:^| )(?:" + PHRASES.map(fold).join("|") + ")");
// CJK phrases appear inside longer runs with no spaces
const CJK_RE = new RegExp(PHRASES.filter(p => /[぀-鿿가-힯]/.test(p)).map(fold).join("|"));

/** Facts about one control, read from the page (read-only). */
export interface ControlFacts {
  tag?: string; role?: string; type?: string; labels: string[]; ids: string[];
  /** it submits its form */
  submit?: boolean;
  /** its form has card fields (cc-number, cvc, expiry...) */
  cardForm?: boolean;
  /** its form's action */
  action?: string;
  /** focus is inside a frame from another site, which cannot be read */
  unreadableFrame?: boolean;
  frameId?: number;
}

/** Why one of these controls (the target, its form's submit buttons) buys, or null. */
export function purchaseReason(facts: ControlFacts[]): string | null {
  for (const f of facts) {
    const why = controlBuys(f);
    if (why) return why;
  }
  return null;
}

/** Why this control buys (the phrase or id it matched), or null. */
export function controlBuys(f: ControlFacts): string | null {
  if (f.unreadableFrame) return "focus inside a frame from another site";
  const labels = f.labels.filter(Boolean).map(normaliseLabel).filter(l => l.length <= MAX_LABEL + 2 && l.trim());
  const submit = !!f.submit || f.type === "submit" || f.type === "image";
  if (submit && f.cardForm) return "a form with card fields";
  // a buying phrase in any label wins over a safe phrase in another label
  for (const l of labels) {
    if (SAFE_RE.test(l)) continue;
    const m = PHRASE_RE.exec(l) || CJK_RE.exec(l);
    if (m) return m[0].trim();
    if (submit && EXACT_SUBMIT.test(l)) return l.trim();
  }
  if (submit && !labels.length && f.action && ACTION_RE.test(f.action)) return `an unlabelled submit of ${f.action}`;
  const control = ["button", "a", "input", "summary", "label"].includes((f.tag || "").toLowerCase()) || f.role === "button" || submit || f.type === "button";
  if (control && !labels.some(l => SAFE_RE.test(l))) {
    for (const id of f.ids) if (id && ID_RE.test(id) && !/add.?to.?cart|unsubscribe/i.test(id)) return id;
  }
  return null;
}
