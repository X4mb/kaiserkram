import { metricUnit, scaleNumbers, toMetric } from './convert.js';

/**
 * The canvas half of Metric Units: the ruler and token-drag labels and the elevation tooltip over
 * tokens are drawn from the scene's grid units ("ft", "yd"), not from any window, so they are
 * converted where Foundry builds them. The scene keeps its units; only the shown text changes.
 */

type Text = { total?: string; delta?: string; units?: string };
type LabelContext = { units?: string; distance?: Text; elevation?: Text; cost?: Text } | void;
type Proto = Record<string | symbol, unknown>;

const PATCHED = Symbol('kaiserkramMetric');

function convertLabel(context: LabelContext): LabelContext {
  if (!context?.units) return context;
  const unit = metricUnit(context.units);
  if (!unit) return context;
  const lang = game.i18n?.lang ?? 'en';
  const scale = (t: Text | undefined) => {
    if (!t) return;
    if (t.total) t.total = scaleNumbers(t.total, unit.factor, lang);
    if (t.delta) t.delta = scaleNumbers(t.delta, unit.factor, lang);
  };
  scale(context.distance);
  scale(context.elevation);
  // A cost in the scene's units is a distance too; anything else (action points…) stays.
  if (context.cost && context.cost.units === context.units) {
    scale(context.cost);
    context.cost.units = unit.name;
  }
  context.units = unit.name;
  return context;
}

/**
 * Wrap `method` on `proto`, passing its result through `convert`. Once per class; the conversions
 * leave converted text alone, so a subclass calling a wrapped parent converts only once.
 */
function wrap(proto: Proto | undefined, method: string, convert: (result: never) => unknown): void {
  const original = proto?.[method] as ((...args: unknown[]) => unknown) & { [PATCHED]?: true };
  if (!proto || typeof original !== 'function' || (Object.hasOwn(proto, method) && original[PATCHED])) return;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    return convert(original.apply(this, args) as never);
  } as typeof original;
  wrapped[PATCHED] = true;
  proto[method] = wrapped;
}

/** Patch the ruler, token ruler and token classes in use (a system's own subclasses included). */
export function patchCanvasUnits(): void {
  const config = CONFIG as unknown as {
    Canvas?: { rulerClass?: { prototype: Proto } };
    Token?: { rulerClass?: { prototype: Proto } | null; objectClass?: { prototype: Proto } };
  };
  wrap(config.Canvas?.rulerClass?.prototype, '_getWaypointLabelContext', convertLabel);
  wrap(config.Token?.rulerClass?.prototype ?? undefined, '_getWaypointLabelContext', convertLabel);
  // The "+10 ft" over a raised token.
  wrap(config.Token?.objectClass?.prototype, '_getTooltipText', (text: string) => (typeof text === 'string' ? toMetric(text) : text));
}
