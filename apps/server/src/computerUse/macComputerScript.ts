/**
 * The JavaScript for Automation program behind every computer-use action on
 * macOS. It runs in a fresh `osascript` child per call, so a permission the
 * user just granted is seen on the next call without restarting anything.
 *
 * Input goes through CoreGraphics events and the Accessibility API directly,
 * never through Apple Events (`tell application "System Events"`): those need
 * a third, per-app Automation grant that a background server cannot even
 * prompt for, which is how agents used to fail with "not authorized".
 *
 * `run(argv)` takes one JSON argument `{ op, needs?, ...params }` and prints
 * `{ ok: true, value }`, `{ ok: false, error }`, or `{ ok: false, missing }`
 * when the grant named by `needs` is absent.
 */
export const MAC_COMPUTER_SCRIPT = String.raw`
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
ObjC.bindFunction('CGRequestScreenCaptureAccess', ['bool', []]);
ObjC.bindFunction('CGEventKeyboardSetUnicodeString', ['void', ['void *', 'unsigned long', 'void *']]);

function fail(message) { throw new Error(message); }
function num(value) { return Number(value); }
function workspace() { return $.NSWorkspace.sharedWorkspace; }
function appName(app) { return app && !app.isNil() ? app.localizedName.js : null; }
function frontmost() { return appName(workspace().frontmostApplication); }

function displays() {
  var screens = $.NSScreen.screens;
  var count = num(screens.count);
  if (count === 0) return [];
  var mainHeight = screens.objectAtIndex(0).frame.size.height;
  var out = [];
  for (var i = 0; i < count; i++) {
    var frame = screens.objectAtIndex(i).frame;
    out.push({
      display: i + 1,
      x: frame.origin.x,
      y: mainHeight - (frame.origin.y + frame.size.height),
      width: frame.size.width,
      height: frame.size.height,
    });
  }
  return out;
}

function probe() {
  return {
    accessibility: $.AXIsProcessTrusted() === true,
    screenRecording: $.CGPreflightScreenCaptureAccess() === true,
    displays: displays().length,
  };
}

function regularApps() {
  var running = workspace().runningApplications;
  var out = [];
  for (var i = 0; i < num(running.count); i++) {
    var app = running.objectAtIndex(i);
    if (num(app.activationPolicy) !== 0) continue;
    out.push(app);
  }
  return out;
}

function findApp(selector) {
  if (selector === undefined || selector === null || selector === '') {
    var front = workspace().frontmostApplication;
    if (front.isNil()) fail('No app is in front.');
    return front;
  }
  var wanted = String(selector).toLowerCase();
  var apps = regularApps();
  for (var i = 0; i < apps.length; i++) {
    var bundleId = apps[i].bundleIdentifier;
    if (appName(apps[i]).toLowerCase() === wanted) return apps[i];
    if (!bundleId.isNil() && bundleId.js.toLowerCase() === wanted) return apps[i];
  }
  fail(selector + ' is not running. Call computer_open_app first, or computer_apps for the exact name.');
}

function attr(element, name) {
  var ref = Ref();
  var error = $.AXUIElementCopyAttributeValue(element, $(name), ref);
  if (error === -25211) fail('Accessibility permission is missing.');
  return error === 0 ? ref[0] : undefined;
}

function text(element, name) {
  var value = attr(element, name);
  if (value === undefined || value === null) return undefined;
  try {
    var unwrapped = ObjC.deepUnwrap(ObjC.castRefToObject(value));
    if (typeof unwrapped === 'string') {
      var trimmed = unwrapped.trim();
      if (trimmed === '') return undefined;
      return trimmed.length > 200 ? trimmed.slice(0, 199) + '…' : trimmed;
    }
    if (typeof unwrapped === 'number' || typeof unwrapped === 'boolean') return String(unwrapped);
  } catch (error) {}
  return undefined;
}

function pair(element, name) {
  var value = attr(element, name);
  if (value === undefined || value === null) return undefined;
  var description = ObjC.castRefToObject(value).description.js;
  var match = /x:(-?[\d.]+) y:(-?[\d.]+)/.exec(description) || /w:(-?[\d.]+) h:(-?[\d.]+)/.exec(description);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

function children(element) {
  var value = attr(element, 'AXChildren');
  if (value === undefined || value === null) return [];
  var array = ObjC.castRefToObject(value);
  var out = [];
  for (var i = 0; i < num(array.count); i++) out.push(array.objectAtIndex(i));
  return out;
}

function actions(element) {
  var ref = Ref();
  if ($.AXUIElementCopyActionNames(element, ref) !== 0 || !ref[0]) return [];
  var names = ObjC.deepUnwrap(ObjC.castRefToObject(ref[0]));
  return Array.isArray(names) ? names : [];
}

function rootWindow(app) {
  var element = $.AXUIElementCreateApplication(app.processIdentifier);
  var focused = attr(element, 'AXFocusedWindow');
  if (focused) return { app: element, window: ObjC.castRefToObject(focused) };
  var windows = attr(element, 'AXWindows');
  var list = windows ? ObjC.castRefToObject(windows) : null;
  if (list && num(list.count) > 0) return { app: element, window: list.objectAtIndex(0) };
  return { app: element, window: null };
}

function describe(element, path, depth) {
  var entry = { path: path, depth: depth, role: text(element, 'AXRole') || 'AXUnknown' };
  var title = text(element, 'AXTitle'); if (title) entry.title = title;
  var value = text(element, 'AXValue'); if (value !== undefined && value !== '') entry.value = value;
  var description = text(element, 'AXDescription'); if (description) entry.description = description;
  var position = pair(element, 'AXPosition');
  var size = pair(element, 'AXSize');
  if (position && size) {
    entry.x = Math.round(position[0] + size[0] / 2);
    entry.y = Math.round(position[1] + size[1] / 2);
    entry.width = Math.round(size[0]);
    entry.height = Math.round(size[1]);
  }
  var enabled = text(element, 'AXEnabled'); if (enabled === 'false') entry.enabled = false;
  var names = actions(element).filter(function (name) { return name !== 'AXShowMenu' && name !== 'AXScrollToVisible'; });
  if (names.length > 0) entry.actions = names;
  return entry;
}

function ui(input) {
  var app = findApp(input.app);
  var root = rootWindow(app);
  if (!root.window) return { app: appName(app), window: null, elements: [], truncated: false };
  var maxDepth = input.maxDepth || 12;
  var maxElements = input.maxElements || 400;
  var elements = [];
  var truncated = false;
  var stack = [{ element: root.window, path: '0', depth: 0 }];
  while (stack.length > 0) {
    if (elements.length >= maxElements) { truncated = true; break; }
    var next = stack.pop();
    var entry = describe(next.element, next.path, next.depth);
    // Unlabelled layout groups add nothing an agent can act on; their children still do.
    var informative = entry.title || entry.value || entry.description || entry.actions || next.depth === 0;
    if (informative) elements.push(entry);
    if (next.depth >= maxDepth) { truncated = true; continue; }
    var kids = children(next.element);
    for (var i = kids.length - 1; i >= 0; i--) stack.push({ element: kids[i], path: next.path + '.' + i, depth: next.depth + 1 });
  }
  return { app: appName(app), window: text(root.window, 'AXTitle') || null, elements: elements, truncated: truncated };
}

function press(input) {
  var app = findApp(input.app);
  var root = rootWindow(app);
  if (!root.window) fail(appName(app) + ' has no open window.');
  var parts = String(input.path).split('.');
  if (parts[0] !== '0') fail('Paths start at 0, the window. Call computer_ui for current paths.');
  var element = root.window;
  for (var i = 1; i < parts.length; i++) {
    var kids = children(element);
    var index = Number(parts[i]);
    if (!(index >= 0 && index < kids.length)) fail('The window changed since computer_ui; call it again for current paths.');
    element = kids[index];
  }
  var action = input.action || 'AXPress';
  var error = $.AXUIElementPerformAction(element, $(action));
  if (error !== 0) fail(action + ' failed on ' + input.path + ' (AXError ' + error + '). Try computer_click at its x and y.');
  delay(0.15);
  return { frontmostApp: frontmost() };
}

function post(event) { $.CGEventPost($.kCGHIDEventTap, event); }

function mouse(type, x, y, button) {
  return $.CGEventCreateMouseEvent($(), type, $.CGPointMake(x, y), button);
}

function click(input) {
  var right = input.button === 'right';
  var down = right ? $.kCGEventRightMouseDown : $.kCGEventLeftMouseDown;
  var up = right ? $.kCGEventRightMouseUp : $.kCGEventLeftMouseUp;
  var button = right ? $.kCGMouseButtonRight : $.kCGMouseButtonLeft;
  post(mouse($.kCGEventMouseMoved, input.x, input.y, button));
  delay(0.05);
  var count = Math.max(1, Math.min(3, input.count || 1));
  for (var i = 1; i <= count; i++) {
    var pressed = mouse(down, input.x, input.y, button);
    $.CGEventSetIntegerValueField(pressed, $.kCGMouseEventClickState, i);
    post(pressed);
    var released = mouse(up, input.x, input.y, button);
    $.CGEventSetIntegerValueField(released, $.kCGMouseEventClickState, i);
    post(released);
    delay(0.03);
  }
  delay(0.15);
  return { frontmostApp: frontmost() };
}

function drag(input) {
  var button = $.kCGMouseButtonLeft;
  post(mouse($.kCGEventMouseMoved, input.fromX, input.fromY, button));
  delay(0.05);
  post(mouse($.kCGEventLeftMouseDown, input.fromX, input.fromY, button));
  var steps = 12;
  for (var i = 1; i <= steps; i++) {
    var x = input.fromX + ((input.toX - input.fromX) * i) / steps;
    var y = input.fromY + ((input.toY - input.fromY) * i) / steps;
    post(mouse($.kCGEventLeftMouseDragged, x, y, button));
    delay(0.016);
  }
  post(mouse($.kCGEventLeftMouseUp, input.toX, input.toY, button));
  delay(0.15);
  return { frontmostApp: frontmost() };
}

function scroll(input) {
  post(mouse($.kCGEventMouseMoved, input.x, input.y, $.kCGMouseButtonLeft));
  delay(0.05);
  // Wheel deltas are positive up/left, so the tool's down/right deltas are negated.
  post($.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 2, -(input.dy || 0), -(input.dx || 0)));
  delay(0.15);
  return { frontmostApp: frontmost() };
}

function typeText(input) {
  var value = String(input.text);
  // Events carry at most 20 UTF-16 units; slicing by code point keeps emoji whole.
  var chunks = [];
  var current = '';
  Array.from(value).forEach(function (character) {
    if ((current + character).length > 20) { chunks.push(current); current = ''; }
    current += character;
  });
  if (current.length > 0) chunks.push(current);
  chunks.forEach(function (chunk) {
    var data = $(chunk).dataUsingEncoding($.NSUTF16LittleEndianStringEncoding);
    var length = num(data.length) / 2;
    [true, false].forEach(function (isDown) {
      var event = $.CGEventCreateKeyboardEvent($(), 0, isDown);
      $.CGEventKeyboardSetUnicodeString(event, length, data.bytes);
      post(event);
    });
    delay(0.01);
  });
  delay(0.1);
  return { frontmostApp: frontmost() };
}

function key(input) {
  [true, false].forEach(function (isDown) {
    var event = $.CGEventCreateKeyboardEvent($(), input.keyCode, isDown);
    $.CGEventSetFlags(event, input.flags);
    post(event);
  });
  delay(0.15);
  return { frontmostApp: frontmost() };
}

function apps() {
  var front = frontmost();
  return {
    frontmostApp: front,
    apps: regularApps().map(function (app) {
      var bundleId = app.bundleIdentifier;
      return {
        name: appName(app),
        bundleId: bundleId.isNil() ? null : bundleId.js,
        pid: num(app.processIdentifier),
        frontmost: app.active === true,
        hidden: app.hidden === true,
      };
    }),
  };
}

function activate(input) {
  var app = findApp(input.app);
  app.activateWithOptions($.NSApplicationActivateAllWindows);
  delay(0.3);
  return { frontmostApp: frontmost() };
}

function request(input) {
  if (input.permission === 'accessibility') {
    $.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: true }));
  } else {
    $.CGRequestScreenCaptureAccess();
  }
  return probe();
}

var handlers = {
  probe: probe,
  request: request,
  displays: function () { return { displays: displays(), frontmostApp: frontmost() }; },
  apps: apps,
  activate: activate,
  ui: ui,
  press: press,
  click: click,
  drag: drag,
  scroll: scroll,
  type: typeText,
  key: key,
};

function run(argv) {
  try {
    var input = JSON.parse(argv[0]);
    // Checked in the same process that acts, so the answer cannot go stale in between.
    if (input.needs === 'accessibility' && $.AXIsProcessTrusted() !== true)
      return JSON.stringify({ ok: false, missing: 'accessibility' });
    if (input.needs === 'screen-recording' && $.CGPreflightScreenCaptureAccess() !== true)
      return JSON.stringify({ ok: false, missing: 'screen-recording' });
    var handler = handlers[input.op];
    if (!handler) fail('Unknown computer-use operation ' + input.op + '.');
    return JSON.stringify({ ok: true, value: handler(input) });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String((error && error.message) || error) });
  }
}
`;
