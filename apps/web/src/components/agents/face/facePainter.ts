import { RAYON } from "./engine/repere";
import type { BotFrame } from "./engine/engine";

/**
 * Writes engine frames into one layer of the SVG skeleton rendered by `AgentFace`
 * (the agent's body, or the indicator drawn over it in layered states).
 *
 * The fixed parts (body, two eye holes, notch, notification dot) are updated by
 * attribute, and only when a value changes, so an idle face costs a few
 * `setAttribute` calls per frame. Arcs and dots vary in count and only appear in
 * a few states; those groups are rebuilt as markup, and skipped when unchanged.
 * Layering follows bloub's `BloubBot.vue`: back half of the arcs, dots behind,
 * paper-backed body, dots in front, notification dot, front half of the arcs.
 */
export class FacePainter {
  private readonly cache = new Map<Element, Map<string, string>>();
  private readonly markupCache = new Map<Element, string>();
  private readonly maskBody: SVGPathElement;
  private readonly paperBody: SVGPathElement;
  private readonly body: SVGGElement;
  private readonly eyes: SVGPathElement[];
  private readonly notch: SVGCircleElement;
  private readonly notif: SVGCircleElement;
  private readonly gradients: SVGElement;
  private readonly arcsBack: SVGGElement;
  private readonly arcsFront: SVGGElement;
  private readonly dotsBehind: SVGGElement;
  private readonly dotsFront: SVGGElement;

  constructor(
    private readonly root: SVGGElement,
    private readonly uid: string,
    public ink: string,
  ) {
    const part = <T extends Element>(name: string) =>
      root.querySelector<T>(`[data-part="${name}"]`)!;
    this.maskBody = part("mask-body");
    this.paperBody = part("paper");
    this.body = part("body");
    this.eyes = [...root.querySelectorAll<SVGPathElement>('[data-part="eye"]')];
    this.notch = part("notch");
    this.notif = part("notif");
    this.gradients = part("gradients");
    this.arcsBack = part("arcs-back");
    this.arcsFront = part("arcs-front");
    this.dotsBehind = part("dots-behind");
    this.dotsFront = part("dots-front");
  }

  private set(element: Element, name: string, value: string | number) {
    let attributes = this.cache.get(element);
    if (!attributes) {
      attributes = new Map();
      this.cache.set(element, attributes);
    }
    const text = String(value);
    if (attributes.get(name) === text) return;
    attributes.set(name, text);
    element.setAttribute(name, text);
  }

  private markup(element: Element, html: string) {
    if (this.markupCache.get(element) === html) return;
    this.markupCache.set(element, html);
    element.innerHTML = html;
  }

  /** Opacity of the whole layer; the indicator fades in and out with it. */
  fade(opacity: number) {
    this.set(this.root, "opacity", opacity);
  }

  paint(frame: BotFrame) {
    this.set(this.maskBody, "d", frame.bodyPath);
    this.set(this.paperBody, "d", frame.bodyPath);
    this.set(this.body, "opacity", frame.bodyAlpha);

    for (let index = 0; index < this.eyes.length; index++) {
      const element = this.eyes[index]!;
      const eye = frame.eyes[index];
      if (!eye) {
        this.set(element, "opacity", 0);
        continue;
      }
      this.set(element, "d", eye.d);
      this.set(element, "transform", eye.matrix);
      this.set(element, "opacity", eye.alpha);
    }

    this.set(this.notch, "r", frame.notch?.r ?? 0);
    this.set(this.notif, "r", frame.notif?.r ?? 0);
    if (frame.notch) {
      this.set(this.notch, "cx", frame.notch.x);
      this.set(this.notch, "cy", frame.notch.y);
    }
    if (frame.notif) {
      this.set(this.notif, "cx", frame.notif.x);
      this.set(this.notif, "cy", frame.notif.y);
    }

    this.markup(this.gradients, frame.arcs.map((arc) => this.gradient(arc)).join(""));
    this.markup(this.arcsBack, frame.arcs.map((arc) => this.arc(arc, arc.back)).join(""));
    this.markup(this.arcsFront, frame.arcs.map((arc) => this.arc(arc, arc.front)).join(""));
    const dots = frame.dots.map((dot) => this.dot(dot)).join("");
    this.markup(this.dotsBehind, frame.dotsBehind ? dots : "");
    this.markup(this.dotsFront, frame.dotsBehind ? "" : dots);
  }

  private gradient(arc: BotFrame["arcs"][number]) {
    const { grad } = arc;
    const last = grad.stops.length - 1;
    const stops = grad.stops
      .map((color, index) => `<stop offset="${index / last}" stop-color="${color}"/>`)
      .join("");
    return `<linearGradient id="${this.uid}-${arc.id}" gradientUnits="userSpaceOnUse" x1="${grad.x1}" y1="${grad.y1}" x2="${grad.x2}" y2="${grad.y2}">${stops}</linearGradient>`;
  }

  private arc(arc: BotFrame["arcs"][number], d: string) {
    return `<path d="${d}" stroke="url(#${this.uid}-${arc.id})" stroke-width="${arc.width}" opacity="${arc.opacity}"/>`;
  }

  /**
   * bloub hazes far particles by mixing the body colour toward the page colour.
   * Faces sit on any background here, so the same haze is expressed as opacity,
   * which is identical whenever the page colour is the background behind the face.
   */
  private dot(dot: BotFrame["dots"][number]) {
    const fill = dot.color ?? this.ink;
    const opacity = dot.opacity * (dot.depth ?? 1);
    return dot.d
      ? `<path d="${dot.d}" fill="${fill}" opacity="${opacity}" transform="translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})"/>`
      : `<circle cx="${dot.x}" cy="${dot.y}" r="${dot.r}" fill="${fill}" opacity="${opacity}"/>`;
  }
}
