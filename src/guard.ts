// Purchase guard: Ghostwright does not place orders, pay, subscribe to paid
// plans, donate or start paid trials unless allowPurchases is true. It runs
// below the model: a click (by id, or by point, also inside a frame), a
// check, Enter or Space anywhere in a key sequence, a newline in typed text,
// or a submit of a form whose submit control buys or that holds card fields
// is refused, whoever chose the action (a model, do(), or a replayed flow).
// "Add to cart" and "Proceed to checkout" pass. Words that buy only when
// money is in play ("Subscribe", "Confirm", "Book now", a free trial) are
// refused only in a money context: a price near the control or in its form,
// card fields, or a checkout, cart, payment, billing or pricing page. A
// newsletter "Subscribe" or an appointment "Confirm" pays nothing.

// Phrases that always commit money. Written plainly; matched after normaliseLabel.
const PHRASES = [
  // English
  "place (your |my |the )?order", "place order", "submit (your |my )?order", "order now", "order and pay",
  "order with obligation to pay", "complete (your |my |the )?(order|purchase|payment)", "complete and pay",
  "confirm (and|to) pay", "confirm (your |my |the )?(order|purchase|payment)",
  "buy now", "buy it now", "buy with 1 ?click", "1 ?click buy", "one ?click buy", "commit to buy",
  "pay now", "pay (with|by) \\S+", "pay \\S*\\d\\S*", "make (a )?payment", "purchase now", "complete checkout", "finish (your )?purchase",
  "book and pay", "reserve and pay", "place (a |your )?bid", "bid now", "subscribe and pay", "donate( now| today| \\S*\\d\\S*)?", "give now",
  "charge (my|the|your|this) (card|account)", "charge card",
  // German
  "jetzt kaufen", "zahlungspflichtig bestellen", "kostenpflichtig bestellen", "bestellung (aufgeben|abschicken|abschliessen|absenden)",
  "jetzt bezahlen", "kaufen und bezahlen", "jetzt bestellen", "jetzt spenden",
  // French
  "acheter maintenant", "payer maintenant", "valider (la |ma |votre )?commande", "confirmer (la |ma )?commande",
  "confirmer et payer", "commander maintenant", "commande avec obligation de paiement", "payer \\S*\\d\\S*", "faire un don",
  // Spanish
  "realizar (el |tu )?pedido", "comprar ahora", "pagar ahora", "confirmar (el )?pedido", "confirmar (la )?compra",
  "confirmar y pagar", "finalizar pedido", "pedido con obligacion de pago", "donar",
  // Italian
  "acquista ora", "effettua (l )?ordine", "conferma (l )?ordine", "conferma e paga", "paga ora", "ordine con obbligo di pagamento", "dona ora",
  // Portuguese
  "comprar agora", "fazer (o )?pedido", "finalizar (o )?pedido", "pagar agora", "confirmar e pagar", "encomenda com obrigacao de pagamento",
  // Dutch
  "bestelling plaatsen", "nu kopen", "nu betalen", "bestellen en betalen", "bestelling met betalingsverplichting",
  // Polish
  "kupuje i place", "zamawiam z obowiazkiem zaplaty", "zamow i zaplac", "kup teraz", "zaplac", "potwierdzam zakup", "zamawiam",
  // Swedish
  "kop nu", "betala nu", "slutfor kop", "slutfor (din )?bestallning", "bekrafta (kop|bestallning)", "bestall nu", "lagg bestallning",
  // Turkish
  "siparisi onayla", "siparisi tamamla", "satin al", "simdi satin al", "simdi ode", "odeme yap",
  // Russian
  "оформить заказ", "подтвердить заказ", "оплатить", "купить сейчас", "купить в 1 клик",
  // Chinese
  "提交订单", "立即购买", "确认订单", "确认支付", "立即支付", "去支付", "立即下单", "马上购买", "提交訂單", "立即購買", "確認訂單", "立即付款",
  // Japanese
  "注文を確定", "注文する", "購入する", "今すぐ購入", "今すぐ買う", "支払う", "お支払い", "注文確定", "購入手続き",
  // Korean
  "주문하기", "결제하기", "구매하기", "바로구매", "주문 완료",
];

// Words that commit money only when money is in play, anywhere in a label.
const SOFT_PHRASES = [
  "get it (today|now)", "yes (buy|pay|purchase|order|charge)( \\S+){0,3}",
  "complete (your |my |the )?(booking|reservation|rental)", "(send|submit) (a |the |my |your )?payment", "authori[sz]e( \\S*\\d\\S*| (the )?(payment|charge|amount))",
  "tip \\S*\\d\\S*", "(leave|add|send|give) (a )?tip( \\S*\\d\\S*)?", "top up( now| \\S*\\d\\S*)?", "join (now|today)", "join (for|at) \\S*\\d\\S*",
  "reserve (my|a|your|this) (place|spot|seat|seats|table|room|ticket|tickets)", "subscribe now", "subscribe and save", "subscribe for", "subscribe today", "book now", "rent now", "reserve now", "upgrade now", "renew now",
  "confirm (your |my |the )?(booking|subscription|reservation|upgrade|plan|membership|rental)",
  "start (your |my |a )?(\\d+ ?days? )?(free )?trial", "\\d+ ?days? free trial", "try (it )?free",
  "get premium", "go premium", "get pro", "go pro",
  "renew (membership|subscription|plan)", "(join|try|get|start) (amazon )?prime", "start (your |my )?membership", "sign up for (amazon )?prime",
  "abonnieren", "gratis testen", "probemonat", "kostenlos testen", "mitglied werden", "jetzt buchen",
  "s abonner", "essai gratuit", "reserver maintenant", "suscribirse", "suscribete", "prueba gratis", "reservar ahora",
  "abbonati", "prova gratis", "prenota ora", "assinar agora", "teste gratis", "abonneren", "gratis proberen", "abone ol",
  "оформить подписку", "подписаться", "订阅", "定期購入", "구독하기",
];

// The same, when they are the whole label ("Confirm", "Upgrade to Pro"): inside a longer
// label these words say something else ("Confirm password", "Address book", "Book reviews").
const SOFT_WHOLE = /^ (top up|tip|join|(buy|purchase|pay|order|checkout|check out)( (it|this|these|all|now|today|here|online|securely|ticket|tickets|plan|item|items))?|subscribe|confirm|book|book (it|this|room|stay|trip|flight|ticket|tickets|seat|seats|table)|reserve|rent|upgrade|upgrade (to|your|plan|account)( \S+){0,3}|renew) $/;

// Labels with those words that never pay.
const SOFT_SAFE_RE = / (upgrade (your |the |my )?(browser|app|version|layout|view|software|os|system|driver|drivers|firmware)|(booking|reservation|payment|tip|top up) (history|details|reference|number|status|reminder|link|request|methods?|settings|options|of the day)|tips? (and|&) tricks|join (our |the |a |my )?(newsletter|mailing list|list|community|discussion|call|meeting|waitlist|wait list|team|chat)|authori[sz]e (app|application|device|access|login|sign in)|order (by|history|status|details|summary|number|tracking)|(view|track|my|past|your) orders?|pay later|subscribe to (our |the |my |this |a )?(\S+ )?(newsletter|blog|updates|mailing list|list|notifications|alerts|channel|rss|feed|thread|topic|podcast|calendar|emails?)|newsletter|book a (demo|call|meeting|consultation|tour|viewing)|free (demo|consultation)) /;

// Labels that only move on: they buy when the page says it charges now
const GENERIC_GO = /^ (continue|confirm|submit|next|proceed|done|ok|okay|yes|finish|complete|go|send|place|accept|agree|agree and continue|confirm and continue|continue to payment) $/;

// Labels that buy when they are the whole label of a submit control.
const EXACT_SUBMIT = /^ (checkout|check out|order|pay|purchase|buy|bestellen|kaufen|commander|comprar|acquista|kopen|kup|kop|заказать|купить|购买|结算|購入|注文|결제|구매) $/;

// Form actions of order, payment and subscription forms.
const ACTION_RE = /(^|[/._-])(order|orders|checkout|purchase|payment|pay|buy|subscribe|subscription|billing|donate)([/._?-]|$)/i;

// ids and names stores give the final button
const ID_RE = /place.?(your.?)?order|submit.?order|buy.?now|one.?click|1.?click|turbo.?checkout|pay.?now|complete.?(order|purchase)|confirm.?(and.?)?pay|checkout.?pay/i;
const SOFT_ID_RE = /subscribe|free.?trial/i;

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

const isCJK = (p: string) => /[぀-鿿가-힯]/.test(p);
// the phrases are lower-case regular expressions: fold accents only, keep the syntax
const PHRASE_RE = new RegExp("(?:^| )(?:" + PHRASES.map(fold).join("|") + ")(?= |$)");
// CJK phrases appear inside longer runs with no spaces
const CJK_RE = new RegExp(PHRASES.filter(isCJK).map(fold).join("|"));
const SOFT_RE = new RegExp("(?:^| )(?:" + SOFT_PHRASES.map(fold).join("|") + ")(?= |$)");
const SOFT_CJK_RE = new RegExp(SOFT_PHRASES.filter(isCJK).map(fold).join("|"));

/**
 * What the page-side check needs to stop a purchase form that a script submits (a click on a box
 * whose handler calls requestSubmit()): the patterns for the form's own submit controls and action.
 */
export const SUBMIT_GUARD = { hard: PHRASE_RE.source, exact: EXACT_SUBMIT.source, action: ACTION_RE.source };

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
  /** a field, a checkbox, a radio button or its label: filling it in or choosing it buys nothing (its form's submit is judged on its own) */
  passive?: boolean;
  /** money is in play: a price near the control or in its form, card fields, or a checkout, cart, payment, billing or pricing page */
  money?: boolean;
  /** the form, the control's own box or its small page says an amount is charged now ("Total $49.00 will be charged to Visa 4242") */
  chargeNow?: boolean;
  /** the control is in a form (a <button> outside one submits nothing) */
  inForm?: boolean;
  /** an Enter in a form with no submit control (implicit submission) */
  implicit?: boolean;
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
  // Enter in a form that has no submit button, when the form itself states a price or a charge
  if (f.implicit && (f.money || f.chargeNow)) return "an Enter that submits a form stating a price";
  // a generic "Continue", "Confirm", "Submit" (or any submit) where the page says the card is charged now
  if (f.chargeNow && ((submit && (f.inForm || f.implicit)) || labels.some(l => GENERIC_GO.test(l)))) return "a submit where the page says the amount is charged now";
  // a text field labelled "Confirm password", a "Pay with card" radio button, a newsletter checkbox:
  // what they say is not something a click on them does
  if (f.passive && !submit) return null;
  // a buying phrase in any label wins over a safe phrase in another label
  for (const l of labels) {
    if (SAFE_RE.test(l)) continue;
    const m = PHRASE_RE.exec(l) || CJK_RE.exec(l);
    if (m) return m[0].trim();
    if (submit && EXACT_SUBMIT.test(l)) return l.trim();
    if (f.money && !SOFT_SAFE_RE.test(l)) {
      const s = SOFT_RE.exec(l) || SOFT_CJK_RE.exec(l) || SOFT_WHOLE.exec(l);
      if (s) return s[0].trim();
    }
  }
  if (submit && !labels.length && f.action && ACTION_RE.test(f.action)) return `an unlabelled submit of ${f.action}`;
  const control = ["button", "a", "input", "summary", "label"].includes((f.tag || "").toLowerCase()) || f.role === "button" || submit || f.type === "button";
  if (control && !labels.some(l => SAFE_RE.test(l))) {
    for (const id of f.ids) if (id && (ID_RE.test(id) || (f.money && SOFT_ID_RE.test(id))) && !/add.?to.?cart|unsubscribe/i.test(id)) return id;
  }
  return null;
}
