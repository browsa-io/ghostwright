// Is a page a bot wall? A deterministic verdict from the page's title, text and markup, used
// for task sets of live pages (set "botwall"; bring your own list with BENCH_EXTRA_TASKS).
const BLOCK_RE =
  /robot or human|are you (a )?(robot|human)|access denied|access to this page has been denied|verify you are (a )?human|just a moment|checking your browser|press (&|and) hold|pardon our interruption|request unsuccessful|unusual traffic|attention required|sorry, we just need to make sure|enter the characters you see|blocked by|captcha-delivery|px-captcha|you have been blocked|not a robot|security check|something went wrong.*verify/i;

export function blockVerdict(snap) {
  if (!snap) return "no page";
  const head = `${snap.title}\n${snap.text.slice(0, 2500)}`;
  if (BLOCK_RE.test(head)) return `block signature: ${head.match(BLOCK_RE)[0]}`;
  if (/captcha-delivery\.com|perimeterx|px-captcha|challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform|_Incapsula_Resource|akamai.*sensor/i.test(snap.html) && snap.text.length < 1500)
    return "challenge markup on a near-empty page";
  if (snap.text.trim().length < 80) return "empty page";
  return null;
}
