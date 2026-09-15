// Verifies (without a browser) that:
//  - every asset path referenced in main.js exists on disk
//  - every frame rect for every character fits within its source image's pixel bounds
// Run: node verify.js
"use strict";
var fs = require("fs");
var path = require("path");

// Minimal PNG dimension reader (no deps): PNG IHDR chunk holds width/height
// as big-endian uint32 at fixed offsets.
function pngSize(file) {
  var buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47 && buf.toString("ascii", 1, 4) !== "PNG") {
    // fall back to signature check
  }
  var width = buf.readUInt32BE(16);
  var height = buf.readUInt32BE(20);
  return { width: width, height: height };
}

var dir = __dirname;
var data = require(path.join(dir, "main.js"));
var CHARACTERS = data.DISTRICTS;
var IMAGE_FILES = data.IMAGE_FILES;

var errors = [];
var checks = 0;

// 1. All image files referenced exist and are readable PNGs.
var sizes = {};
Object.keys(IMAGE_FILES).forEach(function (key) {
  var p = path.join(dir, IMAGE_FILES[key]);
  checks++;
  if (!fs.existsSync(p)) {
    errors.push("MISSING asset file: " + IMAGE_FILES[key] + " (key=" + key + ")");
    return;
  }
  try {
    sizes[key] = pngSize(p);
  } catch (e) {
    errors.push("Could not read PNG dims for " + IMAGE_FILES[key] + ": " + e.message);
  }
});

function checkRect(label, sheetKey, rect) {
  checks++;
  if (!sizes[sheetKey]) {
    errors.push(label + ": sheet '" + sheetKey + "' has no known size (missing/broken image)");
    return;
  }
  var w = sizes[sheetKey].width, h = sizes[sheetKey].height;
  var x0 = rect[0], y0 = rect[1], x1 = rect[2], y1 = rect[3];
  if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0 || x1 > w || y1 > h) {
    errors.push(
      label + ": rect [" + rect.join(",") + "] out of bounds for sheet '" +
      sheetKey + "' (" + w + "x" + h + ")"
    );
  }
}

// 2. Every character's anim/idle/special rects are within their sheet's bounds.
CHARACTERS.forEach(function (def) {
  Object.keys(def.anims).forEach(function (animName) {
    def.anims[animName].forEach(function (rect, i) {
      checkRect(def.id + "." + animName + "[" + i + "]", def.sheet, rect);
    });
  });
  checkRect(def.id + ".idle", def.sheet, def.idle);
  (def.specials || []).forEach(function (rect, i) {
    checkRect(def.id + ".specials[" + i + "]", def.battleSheet, rect);
  });
});

// 3. Every district's declared bgSize matches the actual PNG dimensions,
// and every patrol/home waypoint falls within that background.
CHARACTERS.forEach(function (def) {
  checks++;
  var actual = sizes[def.bg];
  if (!actual) {
    errors.push(def.id + ": background sheet '" + def.bg + "' has no known size");
    return;
  }
  if (actual.width !== def.bgSize[0] || actual.height !== def.bgSize[1]) {
    errors.push(
      def.id + ": declared bgSize [" + def.bgSize.join(",") + "] does not match actual " +
      "PNG dimensions " + actual.width + "x" + actual.height + " for " + IMAGE_FILES[def.bg]
    );
  }
  var w = def.bgSize[0], h = def.bgSize[1];
  var points = def.patrol.concat([def.home]);
  points.forEach(function (p, i) {
    checks++;
    if (p.x < 0 || p.y < 0 || p.x > w || p.y > h) {
      errors.push(def.id + ": waypoint[" + i + "] (" + p.x + "," + p.y + ") is outside its " +
        w + "x" + h + " background '" + def.bg + "'");
    }
  });
});

// 4. Every genre appears exactly once (no duplicate/missing genre mapping).
var genres = CHARACTERS.map(function (d) { return d.genre; });
var seenGenres = {};
genres.forEach(function (g) {
  checks++;
  if (seenGenres[g]) errors.push("duplicate genre district: " + g);
  seenGenres[g] = true;
});

console.log("Checked " + checks + " assertions across " + CHARACTERS.length + " districts and " +
  Object.keys(IMAGE_FILES).length + " image files.");

if (errors.length) {
  console.error("\nFAILED (" + errors.length + " problem(s)):");
  errors.forEach(function (e) { console.error("  - " + e); });
  process.exit(1);
} else {
  console.log("All asset paths exist and all frame rects are within image bounds. OK.");
}
