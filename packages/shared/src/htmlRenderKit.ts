/**
 * The Cogenly kit: a stylesheet and two web components every HTML render
 * gets by default, so an agent's page uses the app's own surfaces, controls
 * and type instead of inventing a look. Every color, radius and font comes
 * from the theme variables the bootstrap injects (`htmlRenderTheme`), so the
 * kit follows the user's palette and light/dark mode live. The few alpha
 * overlays written here (hover fills, control edges) mirror the Tailwind
 * values in `apps/web/src/components/ui`, which have no token of their own.
 *
 * Bare elements are styled through `:where()`, at zero specificity, so any
 * rule the page writes wins; `.cg-*` classes are the explicit versions. A
 * page opts out with `<html data-cg="off">` or the tool's `kit: false`.
 */

const CONTROL_HEIGHT = "32px";
const CONTROL_HEIGHT_SM = "28px";

// `light-dark()` follows the `color-scheme` the bootstrap sets on :root, so
// the kit can pick the app's light or dark treatment without a class.
const TOKENS =
  ":root{" +
  "--cg-radius-sm:calc(var(--radius) - 4px);--cg-radius-md:calc(var(--radius) - 2px);--cg-radius-lg:var(--radius);--cg-radius-xl:calc(var(--radius) + 3px);--cg-radius-2xl:calc(var(--radius) + 4px);" +
  // In-page surfaces rest on one faint hairline (index.css --surface-edge); light mode has none and uses the border.
  "--cg-hairline:var(--surface-edge,var(--border));" +
  "--cg-hover:color-mix(in srgb,var(--foreground) 4%,transparent);" +
  "--cg-selected:color-mix(in srgb,var(--foreground) 6.5%,transparent);" +
  // Inputs and outline buttons: white in light, a translucent step of --input in dark.
  "--cg-control:light-dark(var(--background),color-mix(in srgb,var(--input) 32%,transparent));" +
  "--cg-control-hover:light-dark(var(--cg-hover),color-mix(in srgb,var(--input) 64%,transparent));" +
  "--cg-control-shadow:0 1px 2px rgb(0 0 0/5%),0 1px 0 light-dark(rgb(0 0 0/4%),transparent),inset 0 1px 0 light-dark(transparent,rgb(255 255 255/6%));" +
  "--cg-chart-1:var(--chart-1);--cg-chart-2:var(--chart-2);--cg-chart-3:var(--chart-3);--cg-chart-4:var(--chart-4);--cg-chart-5:var(--chart-5);--cg-chart-6:var(--chart-6);" +
  "}";

const TYPOGRAPHY =
  ":where(*,::before,::after){box-sizing:border-box}" +
  ":where(body){font-size:14px;line-height:1.5}" +
  ":where(h1,h2,h3,h4){margin:1.25em 0 .5em;font-weight:600;line-height:1.3;letter-spacing:-.01em;color:var(--foreground)}" +
  ":where(h1){font-size:20px}:where(h2){font-size:17px}:where(h3){font-size:15px}:where(h4){font-size:14px}" +
  ":where(p,ul,ol,pre,table,figure,blockquote){margin:0 0 10px}" +
  ":where(ul,ol){padding-left:1.25em}:where(li){margin:2px 0}" +
  ":where(body>:first-child,.cg-card>:first-child){margin-top:0}:where(body>:last-child,.cg-card>:last-child){margin-bottom:0}" +
  ":where(small,.cg-small){font-size:12px}:where(.cg-muted,small){color:var(--muted-foreground)}:where(.cg-title){font-weight:500}" +
  ":where(strong,b){font-weight:600}" +
  ":where(blockquote){padding-left:12px;border-left:2px solid var(--border);color:var(--muted-foreground)}" +
  ":where(code,kbd,samp){font-size:13px}" +
  ":where(:not(pre)>code){padding:1px 5px;border-radius:var(--cg-radius-sm);background:var(--code-background);color:var(--code-foreground)}" +
  ":where(pre){padding:12px 14px;border:1px solid var(--cg-hairline);border-radius:var(--cg-radius-lg);background:var(--code-background);color:var(--code-foreground);overflow-x:auto;line-height:1.45}" +
  ":where(kbd){padding:1px 5px;border:1px solid var(--border);border-bottom-width:2px;border-radius:var(--cg-radius-sm);background:var(--muted);font-size:11px}" +
  ":where(hr,.cg-divider){height:0;margin:12px 0;border:0;border-top:1px solid var(--border)}" +
  ":where(a,.cg-link){color:var(--info-foreground);text-decoration:none;text-underline-offset:3px;text-decoration-thickness:from-font}" +
  ":where(a,.cg-link):hover,:where(a,.cg-link):focus-visible{text-decoration:underline}" +
  ":where(img,video){max-width:100%;height:auto}" +
  ":where(img){border-radius:var(--cg-radius-lg)}" +
  ".cg-image{display:block;margin:0 0 10px}.cg-image img{display:block;width:100%;border:1px solid var(--cg-hairline)}.cg-image figcaption{margin-top:6px;font-size:12px;color:var(--muted-foreground)}";

const LAYOUT =
  ".cg-stack{display:flex;flex-direction:column;gap:12px}" +
  ".cg-inline{display:flex;flex-wrap:wrap;align-items:center;gap:8px}" +
  ".cg-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(var(--cg-min,160px),1fr))}" +
  ".cg-inline>:where(input,select,.cg-input,.cg-select){width:auto}" +
  ".cg-grow{flex:1 1 auto;min-width:0}" +
  ".cg-right{margin-left:auto}";

// The app's card: --card fill on one hairline, rounded-xl, a soft halo below
// and the top-left corner lit (index.css corner-glow), which light mode turns off.
const CARD =
  ".cg-card{position:relative;padding:14px 16px;border:1px solid var(--cg-hairline);border-radius:var(--cg-radius-xl);background:var(--card);color:var(--card-foreground);box-shadow:var(--surface-halo,none)}" +
  ".cg-card::after{content:'';pointer-events:none;position:absolute;inset:-1px;padding:1px;border-radius:inherit;" +
  "background:linear-gradient(155deg,rgb(255 255 255/var(--corner-glow,0%)) 0%,transparent 35%),linear-gradient(to bottom,rgb(255 255 255/var(--corner-glow-top,0%)) 0%,transparent 70%);" +
  "mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0)}" +
  ".cg-card-title{margin:0 0 2px;font-size:14px;font-weight:500}" +
  ".cg-card-description{margin:0 0 10px;font-size:12px;color:var(--muted-foreground)}";

const STAT =
  ".cg-stat{display:flex;flex-direction:column;gap:4px}" +
  ".cg-stat-label{font-size:12px;color:var(--muted-foreground)}" +
  ".cg-stat-value{font-size:22px;font-weight:600;line-height:1.2;letter-spacing:-.02em;font-variant-numeric:tabular-nums}" +
  ".cg-stat-delta{font-size:12px;color:var(--muted-foreground);font-variant-numeric:tabular-nums}" +
  ".cg-stat-delta.cg-up{color:var(--success-foreground)}.cg-stat-delta.cg-down{color:var(--destructive-foreground)}";

const BUTTON =
  `:where(button,.cg-button){appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;height:${CONTROL_HEIGHT};padding:0 11px;border:1px solid var(--input);border-radius:var(--cg-radius-lg);background:var(--cg-control);color:var(--foreground);font:inherit;font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;box-shadow:var(--cg-control-shadow);transition:background-color .15s,border-color .15s,box-shadow .15s,scale .15s}` +
  ":where(button,.cg-button):hover{background:var(--cg-control-hover)}" +
  ":where(button,.cg-button):active{scale:.97;box-shadow:none}" +
  ":where(button,.cg-button):disabled,:where(button,.cg-button)[aria-disabled=true]{opacity:.64;pointer-events:none}" +
  ":where(button,.cg-button) svg{width:16px;height:16px;flex:none}" +
  // Primary: the app's neutral default button, near-black on light, near-white on dark.
  ".cg-button:not(.cg-secondary,.cg-ghost,.cg-destructive){border-color:var(--primary);background:var(--primary);color:var(--primary-foreground);box-shadow:0 1px 2px color-mix(in srgb,var(--primary) 24%,transparent),inset 0 1px 0 rgb(255 255 255/16%)}" +
  ".cg-button:not(.cg-secondary,.cg-ghost,.cg-destructive):hover{background:color-mix(in srgb,var(--primary) 90%,transparent)}" +
  ".cg-button.cg-ghost{border-color:transparent;background:transparent;box-shadow:none}.cg-button.cg-ghost:hover{background:var(--cg-hover)}" +
  ".cg-button.cg-destructive{border-color:var(--destructive);background:var(--destructive);color:#fff;box-shadow:0 1px 2px color-mix(in srgb,var(--destructive) 24%,transparent),inset 0 1px 0 rgb(255 255 255/16%)}" +
  ".cg-button.cg-destructive:hover{background:color-mix(in srgb,var(--destructive) 90%,transparent)}" +
  `.cg-button.cg-sm,:where(button).cg-sm{height:${CONTROL_HEIGHT_SM};padding:0 9px;gap:6px;font-size:13px}` +
  ".cg-button.cg-selected,.cg-button[aria-pressed=true]{background:var(--cg-selected);box-shadow:inset 0 0 0 1px var(--border)}";

const BADGE =
  ".cg-badge{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:18px;min-width:18px;padding:0 4px;border:1px solid transparent;border-radius:var(--cg-radius-sm);background:var(--primary);color:var(--primary-foreground);font-size:12px;font-weight:500;line-height:1;white-space:nowrap;vertical-align:middle}" +
  ".cg-badge.cg-secondary{background:var(--secondary);color:var(--secondary-foreground)}" +
  ".cg-badge.cg-outline{border-color:var(--input);background:var(--cg-control);color:var(--foreground)}" +
  ".cg-badge.cg-success{background:light-dark(color-mix(in srgb,var(--success) 8%,transparent),color-mix(in srgb,var(--success) 16%,transparent));color:var(--success-foreground)}" +
  ".cg-badge.cg-warning{background:light-dark(color-mix(in srgb,var(--warning) 8%,transparent),color-mix(in srgb,var(--warning) 16%,transparent));color:var(--warning-foreground)}" +
  ".cg-badge.cg-error,.cg-badge.cg-destructive{background:light-dark(color-mix(in srgb,var(--destructive) 8%,transparent),color-mix(in srgb,var(--destructive) 16%,transparent));color:var(--destructive-foreground)}" +
  ".cg-badge.cg-info{background:light-dark(color-mix(in srgb,var(--info) 8%,transparent),color-mix(in srgb,var(--info) 16%,transparent));color:var(--info-foreground)}" +
  ".cg-badge.cg-lg{height:22px;min-width:22px;padding:0 6px;font-size:13px}";

const TABLE =
  ":where(table,.cg-table){width:100%;border-collapse:collapse;font-size:12px;text-align:left;font-variant-numeric:tabular-nums}" +
  ":where(table,.cg-table) :where(th){height:36px;padding:0 8px;font-weight:500;color:var(--foreground);white-space:nowrap;vertical-align:middle}" +
  ":where(table,.cg-table) :where(td){padding:8px;vertical-align:middle}" +
  ":where(table,.cg-table) :where(tr){border-bottom:1px solid var(--border)}" +
  ":where(table,.cg-table) :where(tbody tr:last-child){border-bottom:0}" +
  ":where(table,.cg-table) :where(tbody tr):hover{background:color-mix(in srgb,var(--muted) 50%,transparent)}" +
  ":where(table,.cg-table) :where(td.cg-num,th.cg-num){text-align:right}" +
  ":where(table,.cg-table) :where(caption){padding:8px;font-size:12px;color:var(--muted-foreground);caption-side:bottom}" +
  // A table inside a card runs edge to edge; the card's padding is the gutter.
  ".cg-card>:where(table,.cg-table){width:calc(100% + 32px);margin-left:-16px;margin-right:-16px}" +
  ".cg-card>:where(table,.cg-table) :where(th:first-child,td:first-child){padding-left:16px}.cg-card>:where(table,.cg-table) :where(th:last-child,td:last-child){padding-right:16px}";

const LIST =
  ".cg-list{display:flex;flex-direction:column;padding:0;margin:0 0 10px;list-style:none;border:1px solid var(--cg-hairline);border-radius:var(--cg-radius-xl);background:var(--card);color:var(--card-foreground);box-shadow:var(--surface-halo,none);overflow:hidden}" +
  ".cg-row{display:flex;align-items:center;gap:12px;min-height:44px;padding:8px 14px;margin:0;border-bottom:1px solid var(--border)}" +
  ".cg-list>.cg-row:last-child{border-bottom:0}" +
  ".cg-row.cg-hover:hover,a.cg-row:hover,button.cg-row:hover{background:var(--cg-hover)}" +
  "a.cg-row{color:inherit;text-decoration:none}" +
  ".cg-row-main{flex:1 1 auto;min-width:0}.cg-row-main>:first-child{font-weight:500}.cg-row-main>:nth-child(2){font-size:12px;color:var(--muted-foreground)}";

const FORMS =
  `:where(input:not([type=checkbox],[type=radio],[type=range],[type=color],[type=file]),select,textarea,.cg-input,.cg-select){appearance:none;display:block;width:100%;min-width:0;height:${CONTROL_HEIGHT};padding:0 11px;border:1px solid var(--input);border-radius:var(--cg-radius-lg);background:var(--cg-control);color:var(--foreground);font:inherit;line-height:${CONTROL_HEIGHT};box-shadow:var(--cg-control-shadow);outline:none;transition:border-color .15s,box-shadow .15s}` +
  ":where(textarea){height:auto;min-height:82px;padding:7px 11px;line-height:1.5;resize:vertical}" +
  ":where(input,select,textarea,.cg-input,.cg-select)::placeholder{color:var(--muted-foreground)}" +
  ":where(input,select,textarea,.cg-input,.cg-select):focus-visible{border-color:var(--ring);box-shadow:inset 0 0 0 3px color-mix(in srgb,var(--ring) 24%,transparent);outline:none!important}" +
  ":where(input,select,textarea,.cg-input,.cg-select):disabled{opacity:.64}" +
  ":where(select,.cg-select){padding-right:30px;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\");background-repeat:no-repeat;background-position:right 9px center;cursor:pointer}" +
  ":where(label,.cg-label){display:inline-flex;align-items:center;gap:8px;font-size:14px}" +
  ".cg-field{display:flex;flex-direction:column;gap:6px}.cg-field>:where(label,.cg-label){font-size:13px;font-weight:500}.cg-field-hint{font-size:12px;color:var(--muted-foreground)}" +
  // Checkbox and radio: the app's 16px controls, filled with --primary when checked.
  ":where(input[type=checkbox],input[type=radio],.cg-checkbox,.cg-radio){appearance:none;flex:none;width:16px;height:16px;margin:0;border:1px solid var(--input);border-radius:4px;background:var(--cg-control);box-shadow:var(--cg-control-shadow);cursor:pointer;vertical-align:-3px;display:inline-grid;place-content:center;transition:background-color .15s,border-color .15s}" +
  ":where(input[type=radio],.cg-radio){border-radius:50%}" +
  ":where(input[type=checkbox],input[type=radio],.cg-checkbox,.cg-radio):checked,:where(.cg-checkbox,.cg-radio)[aria-checked=true]{border-color:var(--primary);background:var(--primary);box-shadow:none}" +
  ":where(input[type=checkbox],.cg-checkbox):checked::before,:where(.cg-checkbox)[aria-checked=true]::before{content:'';width:10px;height:10px;background:var(--primary-foreground);mask:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E\") center/contain no-repeat}" +
  ":where(input[type=radio],.cg-radio):checked::before,:where(.cg-radio)[aria-checked=true]::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--primary-foreground)}" +
  ":where(input[type=checkbox],input[type=radio],.cg-checkbox,.cg-radio):focus-visible{outline:2px solid var(--ring);outline-offset:-2px!important;box-shadow:inset 0 0 0 3px var(--background)}" +
  ":where(input[type=range]){width:100%;accent-color:var(--primary)}:where(input[type=color]){width:32px;height:32px;padding:2px;border:1px solid var(--input);border-radius:var(--cg-radius-lg);background:var(--cg-control)}";

// Tabs: the app's segmented control, a muted track with the selected tab one fill step up.
const TABS =
  ".cg-tablist{display:inline-flex;gap:2px;padding:2px;border-radius:var(--cg-radius-lg);background:color-mix(in srgb,var(--input) 40%,transparent);margin:0 0 12px}" +
  ".cg-tab{height:24px;padding:0 10px;border:0;border-radius:var(--cg-radius-md);background:transparent;color:var(--muted-foreground);font:inherit;font-size:12px;font-weight:500;line-height:1;cursor:pointer;box-shadow:none;transition:background-color .15s,color .15s}" +
  ".cg-tab:hover{background:var(--cg-hover);color:var(--foreground)}" +
  ".cg-tab[aria-selected=true]{background:var(--cg-selected);color:var(--foreground);box-shadow:inset 0 0 0 1px light-dark(transparent,color-mix(in srgb,var(--foreground) 6%,transparent))}" +
  "cg-tabs{display:block}cg-tab{display:block}cg-tab[hidden]{display:none}";

// Choices: quiz answers and approve/deny decisions. A list choice is a cg-list
// of rows with a radio or checkbox indicator; an inline one is a segmented pair.
const CHOICE =
  "cg-choice{display:flex;flex-direction:column;gap:6px;margin:0 0 10px}" +
  "cg-option{display:flex;align-items:center;gap:10px;min-height:38px;padding:8px 12px;border:1px solid var(--cg-hairline);border-radius:var(--cg-radius-lg);background:var(--card);cursor:pointer;user-select:none;outline:none;transition:background-color .15s,border-color .15s}" +
  "cg-option:hover{background:var(--cg-hover)}" +
  "cg-option:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}" +
  "cg-option[aria-checked=true]{border-color:color-mix(in srgb,var(--foreground) 14%,transparent);background:var(--cg-selected)}" +
  "cg-option[aria-disabled=true]{opacity:.64;pointer-events:none}" +
  "cg-option>.cg-indicator{flex:none}" +
  "cg-choice[inline]{flex-direction:row;flex-wrap:wrap;gap:0;display:inline-flex;margin:0;padding:2px;border-radius:var(--cg-radius-lg);background:color-mix(in srgb,var(--input) 40%,transparent)}" +
  "cg-choice[inline] cg-option{min-height:24px;padding:0 10px;border:0;border-radius:var(--cg-radius-md);background:transparent;color:var(--muted-foreground);font-size:12px;font-weight:500}" +
  "cg-choice[inline] cg-option:hover{background:var(--cg-hover);color:var(--foreground)}" +
  "cg-choice[inline] cg-option[aria-checked=true]{background:var(--cg-selected);color:var(--foreground)}" +
  "cg-choice[inline] cg-option.cg-success[aria-checked=true]{background:color-mix(in srgb,var(--success) 16%,transparent);color:var(--success-foreground)}" +
  "cg-choice[inline] cg-option.cg-destructive[aria-checked=true]{background:color-mix(in srgb,var(--destructive) 16%,transparent);color:var(--destructive-foreground)}" +
  "cg-choice[inline] cg-option.cg-warning[aria-checked=true]{background:color-mix(in srgb,var(--warning) 16%,transparent);color:var(--warning-foreground)}" +
  "cg-option.cg-correct{border-color:color-mix(in srgb,var(--success) 50%,transparent);background:color-mix(in srgb,var(--success) 10%,transparent)}" +
  "cg-option.cg-wrong{border-color:color-mix(in srgb,var(--destructive) 50%,transparent);background:color-mix(in srgb,var(--destructive) 10%,transparent)}" +
  "[data-cg-locked] cg-option{pointer-events:none}[data-cg-locked] [data-cg-submit]{opacity:.64;pointer-events:none}";

// A CSS bar chart in the palette: each .cg-bar row sets --value (0-100) and
// optionally --color; the label and the number sit on either side.
const BARS =
  ".cg-bars{display:flex;flex-direction:column;gap:6px;margin:0 0 10px;font-size:12px;font-variant-numeric:tabular-nums}" +
  ".cg-bar{display:grid;grid-template-columns:minmax(64px,var(--cg-label,120px)) 1fr auto;align-items:center;gap:10px}" +
  ".cg-bar>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted-foreground)}" +
  ".cg-bar>i{display:block;height:10px;border-radius:3px;background:color-mix(in srgb,var(--input) 40%,transparent);overflow:hidden}" +
  ".cg-bar>i::before{content:'';display:block;height:100%;width:var(--value,0%);border-radius:inherit;background:var(--color,var(--cg-chart-1))}" +
  ".cg-bar>b{font-weight:500;min-width:3ch;text-align:right}";

export const HTML_RENDER_KIT_CSS =
  TOKENS +
  TYPOGRAPHY +
  LAYOUT +
  CARD +
  STAT +
  BUTTON +
  BADGE +
  TABLE +
  LIST +
  FORMS +
  TABS +
  CHOICE +
  BARS;

/**
 * `<cg-tabs>` and `<cg-choice>`, plus `[data-cg-submit]` buttons. Each with a
 * `name` keeps its value in `window.cogenly.state` under that key (restored
 * when the page re-mounts, synced to every viewer) through one small store
 * that serializes writes and retries once after a lost race. Without a client
 * (the headless preview, a download) the store stays local and silent.
 */
export const HTML_RENDER_KIT_SCRIPT = `(function(){if(window.customElements===undefined||customElements.get("cg-tabs"))return;
var doc={},locked=false,subs={},queue=Promise.resolve(),ready=null;
function bridge(){var c=window.cogenly;return c&&c.state&&window.parent!==window?c:null;}
function apply(s){doc=s&&s.state&&typeof s.state==="object"&&!Array.isArray(s.state)?s.state:{};locked=s?s.locked===true:false;document.documentElement.toggleAttribute("data-cg-locked",locked);for(var k in subs)subs[k].forEach(function(cb){cb(doc[k],locked);});}
function load(){if(ready)return ready;var c=bridge();if(!c)return ready=Promise.resolve();c.state.subscribe(apply);return ready=c.state.get().then(apply,function(){});}
function bind(name,cb){if(!name)return;(subs[name]=subs[name]||[]).push(cb);load().then(function(){cb(doc[name],locked);});}
function write(name,value){if(!name)return;doc=Object.assign({},doc);doc[name]=value;var c=bridge();if(!c)return;queue=queue.then(function(){var next=doc;return c.state.set(next).catch(function(){return c.state.get().then(function(s){apply(s);doc=Object.assign({},doc,next);return c.state.set(doc);});});}).catch(function(){});}
function parsed(fn){if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",fn,{once:true});else fn();}
function key(el,i){return el.getAttribute("value")||el.getAttribute("label")||String(i);}
function fire(el,value){el.dispatchEvent(new CustomEvent("change",{bubbles:true,detail:{name:el.getAttribute("name"),value:value}}));}
class Tabs extends HTMLElement{}
Tabs.prototype.connectedCallback=function(){var self=this;parsed(function(){self.init();});};
Tabs.prototype.init=function(){if(this._ready)return;this._ready=true;var self=this,tabs=Array.prototype.filter.call(this.children,function(c){return c.tagName==="CG-TAB";}),list=document.createElement("div");list.className="cg-tablist";list.setAttribute("role","tablist");this._tabs=tabs;this._buttons=tabs.map(function(tab,i){var b=document.createElement("button");b.type="button";b.className="cg-tab";b.setAttribute("role","tab");b.textContent=tab.getAttribute("label")||"Tab "+(i+1);b.addEventListener("click",function(){self.select(i,true);});tab.setAttribute("role","tabpanel");list.appendChild(b);return b;});this.prepend(list);var want=this.getAttribute("selected"),at=want===null?0:tabs.findIndex(function(t,i){return key(t,i)===want;});this.select(at<0?0:at,false);bind(this.getAttribute("name"),function(v){var j=tabs.findIndex(function(t,i){return key(t,i)===v;});if(j>-1)self.select(j,false);});};
Tabs.prototype.select=function(at,write_){var self=this;this._tabs.forEach(function(t,i){t.hidden=i!==at;self._buttons[i].setAttribute("aria-selected",i===at?"true":"false");self._buttons[i].tabIndex=i===at?0:-1;});var v=key(this._tabs[at],at);if(this.value===v)return;this.value=v;if(write_){write(this.getAttribute("name"),v);fire(this,v);}};
customElements.define("cg-tabs",Tabs);
class Choice extends HTMLElement{}
Choice.prototype.connectedCallback=function(){var self=this;parsed(function(){self.init();});};
Choice.prototype.init=function(){if(this._ready)return;this._ready=true;var self=this,multiple=this.hasAttribute("multiple"),inline=this.hasAttribute("inline"),options=Array.prototype.filter.call(this.children,function(c){return c.tagName==="CG-OPTION";});this._options=options;this._multiple=multiple;this.setAttribute("role",multiple?"group":"radiogroup");options.forEach(function(o,i){o.setAttribute("role",multiple?"checkbox":"radio");o.tabIndex=0;if(!o.hasAttribute("aria-checked"))o.setAttribute("aria-checked","false");if(!inline&&!o.querySelector(".cg-indicator")){var ind=document.createElement("span");ind.className="cg-indicator "+(multiple?"cg-checkbox":"cg-radio");ind.setAttribute("aria-hidden","true");o.prepend(ind);}function toggle(){if(locked||self.hasAttribute("disabled")||o.getAttribute("aria-disabled")==="true")return;var v=key(o,i);if(multiple){var cur=self.value.slice(),j=cur.indexOf(v);if(j>-1)cur.splice(j,1);else cur.push(v);self.set(cur,true);}else self.set(v,true);}o.addEventListener("click",toggle);o.addEventListener("keydown",function(e){if(e.key===" "||e.key==="Enter"){e.preventDefault();toggle();}});});var initial=this.getAttribute("value");this.set(initial===null?(multiple?[]:null):(multiple?initial.split(",").filter(Boolean):initial),false);bind(this.getAttribute("name"),function(v){if(v!==undefined)self.set(v,false);});};
Choice.prototype.set=function(value,write_){if(!this._ready)return;var self=this,multiple=this._multiple,list=multiple?(Array.isArray(value)?value.map(String):[]):(value===null||value===undefined?[]:[String(value)]);this._options.forEach(function(o,i){var on=list.indexOf(key(o,i))>-1;o.setAttribute("aria-checked",on?"true":"false");var ind=o.querySelector(".cg-indicator");if(ind)ind.setAttribute("aria-checked",on?"true":"false");});var next=multiple?list:(list[0]===undefined?null:list[0]);if(JSON.stringify(next)===JSON.stringify(this.value))return;this.value=next;if(write_){write(this.getAttribute("name"),next);fire(this,next);}};
customElements.define("cg-choice",Choice);
document.addEventListener("click",function(e){var b=e.target&&e.target.closest?e.target.closest("[data-cg-submit]"):null;if(!b||locked)return;var c=bridge();if(!c){b.disabled=true;b.textContent=b.getAttribute("data-cg-submitted")||"Submitted";return;}b.disabled=true;queue.then(function(){return c.submit(doc,{lock:b.hasAttribute("data-cg-lock")});}).then(function(){b.textContent=b.getAttribute("data-cg-submitted")||"Submitted";},function(){b.disabled=false;});});
load();})();`;

/** Agent-facing reference for the kit, used in the html_render description. */
export const HTML_RENDER_KIT_GUIDE = [
  'By default every page gets the Cogenly kit, so use it and graphics look like the app around them; write custom styling only when the user asks for a specific look (then opt out with <html data-cg="off"> or kit:false and style everything yourself).',
  "Plain h1-h3, p, ul, table, button, input, select, textarea, a, img, code, pre and hr already look native. Classes:",
  ".cg-card (the app's card; .cg-card-title, .cg-card-description inside), .cg-stack / .cg-inline / .cg-grid (set --cg-min for the column width) / .cg-grow / .cg-right,",
  ".cg-button (primary; add .cg-secondary, .cg-ghost, .cg-destructive, .cg-sm), .cg-badge (add .cg-success, .cg-warning, .cg-error, .cg-info, .cg-secondary, .cg-outline, .cg-lg),",
  ".cg-stat with .cg-stat-label / .cg-stat-value / .cg-stat-delta (.cg-up, .cg-down) for a KPI tile, .cg-table (.cg-num right-aligns a column), .cg-list of .cg-row (a .cg-row-main holds a title line and a muted second line),",
  ".cg-input / .cg-select / .cg-checkbox / .cg-radio, .cg-field (label, control, .cg-field-hint), .cg-divider, .cg-link, .cg-muted / .cg-small / .cg-title, .cg-image (a figure with img and figcaption),",
  ".cg-bars of .cg-bar rows (each sets --value:0-100% and optionally --color) for a small bar chart, and --cg-chart-1 … --cg-chart-6 for chart colors.",
  'Components: <cg-tabs name="view"><cg-tab label="Overview">…</cg-tab><cg-tab label="Details">…</cg-tab></cg-tabs>;',
  '<cg-choice name="q1"><cg-option value="a">Paris</cg-option><cg-option value="b">Rome</cg-option></cg-choice> (add multiple for checkboxes, inline for a segmented approve/deny pair whose options may carry .cg-success / .cg-destructive);',
  "a button with data-cg-submit (and data-cg-lock to lock the page) submits every named value to you as a new user turn. Named values persist in window.cogenly.state under their name, so no script is needed for a quiz or an approve/deny list.",
  "Example:",
  '<div class="cg-grid" style="--cg-min:140px"><div class="cg-card cg-stat"><span class="cg-stat-label">Tests</span><span class="cg-stat-value">412</span><span class="cg-stat-delta cg-up">+12 today</span></div></div>',
  '<div class="cg-card"><h3 class="cg-card-title">Pull requests</h3><table><thead><tr><th>Title</th><th>Status</th></tr></thead><tbody><tr><td>Fix login</td><td><span class="cg-badge cg-success">Merged</span></td></tr></tbody></table></div>',
  '<div class="cg-card"><p class="cg-title">Which city is the capital of France?</p><cg-choice name="q1"><cg-option value="paris">Paris</cg-option><cg-option value="rome">Rome</cg-option></cg-choice>',
  '<div class="cg-inline"><button class="cg-button" data-cg-submit data-cg-lock>Submit</button><button class="cg-button cg-ghost">Skip</button></div></div>',
].join(" ");
