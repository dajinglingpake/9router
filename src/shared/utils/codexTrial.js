import { getModelsByProviderId } from "open-sse/config/providerModels.js";

export const CODEX_TRIAL_PROMPT = "创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画，你不需要任何测试。";
export const CODEX_TRIAL_PROMPT_LIMIT = 20000;
export const CODEX_TRIAL_MODEL = "gpt-6.1-sol";
export const CODEX_TRIAL_EFFORT = "xhigh";
export const CODEX_TRIAL_PARALLEL = 4;
export const CODEX_TRIAL_MAX_PARALLEL = 10;
export const CODEX_TRIAL_MODELS = getModelsByProviderId("codex").filter(model =>
  (!model.kind || model.kind === "llm") && model.quotaFamily !== "review" && !model.id.endsWith("-review") && !model.id.endsWith("[1m]")
);
export const CODEX_TRIAL_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function countTrialHtmlLines(html = "") {
  if (!html) return 0;
  let lines = 0;
  for (let index = 0; index < html.length; index++) {
    if (html[index] === "\r") { lines++; if (html[index + 1] === "\n") index++; }
    else if (html[index] === "\n") lines++;
  }
  return lines + (/[\r\n]$/.test(html) ? 0 : 1);
}

// Preview-only instrumentation; the saved and downloaded HTML stays exactly as generated.
export function trialPreviewDocument(html) {
  const sizing = `<style>html{overflow:hidden!important;scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}</style><script>
(() => {
  // Measure once at the initial viewport: resizing and measuring again can grow
  // vh/% layouts and decorative overflow forever, shrinking the actual artwork.
  const report = async () => {
    await document.fonts?.ready;
    const root = document.documentElement, body = document.body;
    const style = body && getComputedStyle(body);
    const clipped = axis => style && ['hidden','clip'].includes(style[axis]);
    parent.postMessage({type:'9router-codex-preview-size',
      width:clipped('overflowX') ? innerWidth : Math.max(innerWidth,root.scrollWidth,body?.scrollWidth||0),
      height:clipped('overflowY') ? innerHeight : Math.max(innerHeight,root.scrollHeight,body?.scrollHeight||0)},'*');
  };
  if(document.readyState === 'complete') report();
  else addEventListener('load',report,{once:true});
})();
</script>`;
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, () => `${sizing}</body>`) : html + sizing;
}
