// Konoha Pixel Town — throwaway local visual demo for spotify-pixel-town.
// All art: Naruto: Path of the Ninja / Path of the Ninja 2 (DS) rips, The Spriters Resource.
// Plain canvas 2D, no build step, no network calls at runtime (works from file://).
//
// v2: genres-as-characters. Each of the 17 districts below is one genre, mapped to
// one Naruto character, shown in one Naruto location. 8 districts use a distinct real
// location rip; the remaining 9 reuse the Konoha Village map with a canvas ctx.filter
// recolor (noted per-district as `recolored: true`) since we did not find 17 distinct
// same-scale overworld locations across the DS titles we checked (see report).

(function () {
  "use strict";

  var SCALE_MAX = 3;
  var SCALE_TARGET_WIDTH = 720;

  // ---------------------------------------------------------------------
  // Image assets
  // ---------------------------------------------------------------------
  var IMAGE_FILES = {
    town: "assets/town_bg.png",
    forest: "assets/forest_bg.png",
    academyDojo: "assets/academy_dojo.png",
    hokageMonument: "assets/hokage_monument.png",
    hospitalYard: "assets/hospital_yard.png",
    ramenInterior: "assets/ramen_interior.png",
    houseInterior: "assets/house_interior.png",
    konohaEast: "assets/konoha_east_bg.png",

    team07: "assets/team07_overworld.png",
    team08: "assets/team08_overworld.png",
    team10: "assets/team10_overworld.png",
    teamguy: "assets/teamguy_overworld.png",
    sand: "assets/sandsiblings_overworld.png",
    sasukeOW: "assets/sasukecs2_overworld.png",

    narutoBattle: "assets/naruto_battle.png",
    sakuraBattle: "assets/sakura_battle.png",
    sasukeBattle: "assets/sasuke_battle.png",
    kakashiBattle: "assets/kakashi_battle.png",
    shikamaruBattle: "assets/shikamaru_battle.png",
    nejiBattle: "assets/neji_battle.png",
    rockleeBattle: "assets/rocklee_battle.png",
    chojiBattle: "assets/choji_battle2.png",
    inoBattle: "assets/ino_battle2.png",
    guyBattle: "assets/guy_battle2.png",
    tentenBattle: "assets/tenten_battle2.png",
    temariBattle: "assets/temari_battle2.png",
    kankuroBattle: "assets/kankuro_battle2.png",
    kibaBattle: "assets/kiba_battle2.png",
    hinataBattle: "assets/hinata_battle2.png",
    shinoBattle: "assets/shino_battle2.png"
  };

  var images = {};
  var imagesToLoad = 0;
  var imagesLoaded = 0;

  function loadImages(done) {
    for (var key in IMAGE_FILES) {
      imagesToLoad++;
      var img = new Image();
      img.onload = function () {
        imagesLoaded++;
        if (imagesLoaded === imagesToLoad) done();
      };
      img.onerror = function (e) {
        console.error("Failed to load image:", e.target.src);
        imagesLoaded++;
        if (imagesLoaded === imagesToLoad) done();
      };
      img.src = IMAGE_FILES[key];
      images[key] = img;
    }
  }

  // ---------------------------------------------------------------------
  // 17 districts: genre -> character -> location.
  // bg: which IMAGE_FILES key is the backdrop. bgSize: native pixel size of
  // that backdrop (used to size the canvas / clamp patrol waypoints).
  // recolorFilter: a canvas ctx.filter string applied when a district reuses
  // the Konoha Village map instead of a distinct location (see report).
  // ---------------------------------------------------------------------
  var DISTRICTS = [
    {
      genre: "Hip-Hop", id: "naruto", name: "Naruto Uzumaki", artist: "Kendrick Lamar", song: "Not Like Us",
      location: "Konoha Village — Ichiraku Ramen", bg: "town", bgSize: [767, 758],
      sheet: "team07", fps: 6,
      anims: {
        walk_down: [[8,131,23,162],[26,131,42,162],[45,131,61,162]],
        walk_left: [[8,165,23,197],[26,165,40,197],[43,165,57,197]],
        walk_right: [[11,199,25,230],[28,199,42,230],[45,199,60,230]],
        walk_up: [[8,131,23,162],[26,131,42,162],[45,131,61,162]]
      },
      idle: [26,131,42,162], battleSheet: "narutoBattle", specials: [[20,21,55,65],[75,156,119,195]],
      home: {x:495,y:690}, patrol: [{x:495,y:690},{x:450,y:655},{x:540,y:660},{x:470,y:705}],
      note: "walk_up mirrors walk_down (no back sprite on this sheet)"
    },
    {
      genre: "Pop", id: "sakura", name: "Sakura Haruno", artist: "Taylor Swift", song: "Cruel Summer",
      location: "Konoha Village (Pop recolor)", bg: "town", bgSize: [767, 758], recolorFilter: "hue-rotate(300deg) saturate(150%) brightness(1.05)", recolored: true,
      sheet: "team07", fps: 6,
      anims: {
        walk_down: [[206,131,219,162],[222,131,236,162],[239,131,252,162]],
        walk_left: [[206,165,219,197],[222,165,234,197],[237,165,249,197]],
        walk_right: [[205,199,219,230],[222,199,234,230],[237,199,251,230]],
        walk_up: [[206,131,219,162],[222,131,236,162],[239,131,252,162]]
      },
      idle: [222,131,236,162], battleSheet: "sakuraBattle", specials: [[19,16,46,65],[69,158,115,195]],
      home: {x:320,y:350}, patrol: [{x:320,y:350},{x:290,y:320},{x:350,y:330},{x:300,y:375}],
      note: "walk_up mirrors walk_down (no back sprite); location is Konoha Village recolored, not a distinct map"
    },
    {
      genre: "R&B", id: "neji", name: "Neji Hyuga", artist: "Drake", song: "Passionfruit",
      location: "Konoha House Interior", bg: "houseInterior", bgSize: [365, 390],
      sheet: "teamguy", fps: 6,
      anims: {
        walk_down: [[206,135,222,167],[225,135,240,167],[243,135,259,167]],
        walk_left: [[206,170,222,198],[225,170,242,198],[245,170,262,198]],
        walk_right: [[207,201,221,233],[224,201,238,233],[241,201,255,233]],
        walk_up: [[206,135,222,167],[225,135,240,167],[243,135,259,167]]
      },
      idle: [225,135,240,167], battleSheet: "nejiBattle", specials: [[16,15,48,65],[93,145,123,195]],
      home: {x:180,y:200}, patrol: [{x:180,y:200},{x:150,y:180},{x:210,y:190},{x:170,y:230}],
      note: "walk_up mirrors walk_down (no back sprite on this sheet)"
    },
    {
      genre: "Rock/Metal", id: "rocklee", name: "Rock Lee", artist: "Eminem", song: "Lose Yourself",
      location: "Academy Dojo", bg: "academyDojo", bgSize: [520, 540],
      sheet: "teamguy", fps: 7,
      anims: {
        walk_down: [[9,372,24,405],[28,372,44,405],[47,372,62,405]],
        walk_left: [[10,405,25,438],[28,405,41,438],[44,405,57,438]],
        walk_right: [[13,438,28,471],[29,438,42,471],[45,438,58,471]],
        walk_up: [[9,474,24,505],[27,474,43,505],[46,474,61,505]]
      },
      idle: [28,372,44,405], battleSheet: "rockleeBattle", specials: [[19,16,47,63],[79,155,116,193]],
      home: {x:260,y:280}, patrol: [{x:260,y:280},{x:220,y:260},{x:300,y:300},{x:240,y:320}]
    },
    {
      genre: "Lo-fi", id: "shikamaru", name: "Shikamaru Nara", artist: "Mac Miller", song: "Good News",
      location: "Konoha Village (Lo-fi recolor)", bg: "town", bgSize: [767, 758], recolorFilter: "sepia(0.5) saturate(65%) brightness(0.92)", recolored: true,
      sheet: "team10", fps: 5,
      anims: {
        walk_down: [[9,120,25,152],[28,120,44,152],[47,120,63,152]],
        walk_left: [[12,153,26,186],[28,153,41,186],[44,153,58,186]],
        walk_right: [[13,189,27,220],[30,189,43,220],[45,189,59,220]],
        walk_up: [[9,223,25,255],[28,223,44,255],[47,223,63,255]]
      },
      idle: [28,120,44,152], battleSheet: "shikamaruBattle", specials: [[28,12,47,64],[79,145,123,187]],
      home: {x:300,y:150}, patrol: [{x:300,y:150},{x:270,y:170},{x:330,y:180},{x:290,y:120}],
      note: "location is Konoha Village recolored, not a distinct map"
    },
    {
      genre: "Emo/Alt", id: "gaara", name: "Gaara", artist: "Travis Scott", song: "SICKO MODE",
      location: "Hidden Leaf Forest", bg: "forest", bgSize: [1025, 540],
      sheet: "sand", fps: 6,
      anims: {
        walk_down: [[17,158,37,189],[40,158,60,189],[63,158,83,189]],
        walk_left: [[21,192,41,223],[44,192,64,223],[67,192,87,223]],
        walk_right: [[17,226,38,257],[41,226,62,257],[65,226,86,257]],
        walk_up: [[15,262,37,293],[38,262,60,293],[61,262,83,293]]
      },
      idle: [40,158,60,189], battleSheet: "sand", specials: [[95,178,150,230]],
      home: {x:512,y:270}, patrol: [{x:512,y:270},{x:460,y:250},{x:570,y:290},{x:500,y:230}]
    },
    {
      genre: "Darkwave", id: "sasuke", name: "Sasuke Uchiha", artist: "The Weeknd", song: "Blinding Lights",
      location: "Konoha Village (Darkwave recolor)", bg: "town", bgSize: [767, 758], recolorFilter: "hue-rotate(220deg) saturate(130%) brightness(0.55) contrast(1.15)", recolored: true,
      sheet: "sasukeOW", fps: 6,
      anims: {
        walk_down: [[34,90,50,122],[52,90,68,122],[70,90,86,122]],
        walk_left: [[34,124,48,155],[52,124,65,155],[70,124,84,155]],
        walk_right: [[34,158,48,189],[53,158,66,189],[70,158,84,189]],
        walk_up: [[32,191,49,223],[51,191,67,223],[69,191,86,223]]
      },
      idle: [52,90,68,122], battleSheet: "sasukeBattle", specials: [[18,20,54,65],[69,152,119,195]],
      home: {x:150,y:100}, patrol: [{x:150,y:100},{x:120,y:130},{x:180,y:140},{x:140,y:70}],
      note: "overworld sheet is his Cursed-Seal-2 form (no plain-clothes overworld sheet found in POTN1/POTN2); location is Konoha Village recolored"
    },
    {
      genre: "Electronic", id: "kakashi", name: "Kakashi Hatake", artist: "Frank Ocean", song: "Pink + White",
      location: "Konoha Hospital", bg: "hospitalYard", bgSize: [466, 360],
      sheet: "team07", fps: 6,
      anims: {
        walk_down: [[342,131,360,162],[363,131,383,162],[386,131,404,162]],
        walk_left: [[345,165,361,197],[365,165,380,197],[383,165,401,197]],
        walk_right: [[347,199,362,230],[365,199,379,230],[382,199,398,230]],
        walk_up: [[342,131,360,162],[363,131,383,162],[386,131,404,162]]
      },
      idle: [363,131,383,162], battleSheet: "kakashiBattle", specials: [[7,12,49,64],[140,135,185,192]],
      home: {x:230,y:180}, patrol: [{x:230,y:180},{x:190,y:160},{x:270,y:200},{x:220,y:130}],
      note: "walk_up mirrors walk_down (no back sprite on this sheet)"
    },
    {
      genre: "Punk", id: "kiba", name: "Kiba Inuzuka", artist: "​Machine Gun Kelly", song: "bloody valentine",
      location: "Konoha East Market", bg: "konohaEast", bgSize: [550, 845],
      sheet: "team08", fps: 7,
      anims: {
        walk_down: [[22,124,40,156],[43,124,61,156],[64,124,82,156]],
        walk_left: [[29,159,42,191],[45,159,58,191],[61,159,74,191]],
        walk_right: [[28,194,41,226],[44,194,57,226],[60,194,73,226]],
        walk_up: [[20,229,39,261],[42,229,60,261],[63,229,82,261]]
      },
      idle: [43,124,61,156], battleSheet: "kibaBattle", specials: [[23,3,49,64],[67,132,113,191]],
      home: {x:275,y:400}, patrol: [{x:275,y:400},{x:230,y:380},{x:330,y:420},{x:260,y:450}]
    },
    {
      genre: "Folk", id: "hinata", name: "Hinata Hyuga", artist: "Noah Kahan", song: "Stick Season",
      location: "Konoha Village (Folk recolor)", bg: "town", bgSize: [767, 758], recolorFilter: "hue-rotate(60deg) saturate(85%) brightness(1.0)", recolored: true,
      sheet: "team08", fps: 6,
      anims: {
        walk_down: [[43,516,59,552],[24,516,40,552],[62,516,78,552]],
        walk_left: [[42,555,58,591],[23,555,39,591],[61,555,77,591]],
        walk_right: [[43,594,59,630],[24,594,40,630],[62,594,78,630]],
        walk_up: [[43,633,59,669],[24,633,40,669],[62,633,78,669]]
      },
      idle: [43,516,59,552], battleSheet: "hinataBattle", specials: [[22,19,53,64],[144,158,190,194]],
      home: {x:90,y:460}, patrol: [{x:90,y:460},{x:60,y:440},{x:120,y:480},{x:80,y:500}],
      note: "location is Konoha Village recolored, not a distinct map"
    },
    {
      genre: "Ambient", id: "shino", name: "Shino Aburame", artist: "Brian Eno", song: "An Ending (Ascent)",
      location: "Konoha Village (Ambient recolor)", bg: "town", bgSize: [767, 758], recolorFilter: "grayscale(0.35) hue-rotate(180deg) brightness(0.92) saturate(55%)", recolored: true,
      sheet: "team08", fps: 5,
      anims: {
        walk_down: [[224,124,241,158],[244,124,260,158],[263,124,280,158]],
        walk_left: [[229,161,242,195],[245,161,258,195],[261,161,274,195]],
        walk_right: [[229,198,242,232],[245,198,258,232],[261,198,274,232]],
        walk_up: [[225,234,241,268],[244,234,260,268],[263,234,279,268]]
      },
      idle: [244,124,260,158], battleSheet: "shinoBattle", specials: [[25,11,48,64],[142,139,194,194]],
      home: {x:650,y:300}, patrol: [{x:650,y:300},{x:620,y:280},{x:690,y:320},{x:640,y:340}],
      note: "location is Konoha Village recolored, not a distinct map"
    },
    {
      genre: "Jazz", id: "guy", name: "Might Guy", artist: "Louis Armstrong", song: "What a Wonderful World",
      location: "Hokage Monument Training Yard", bg: "hokageMonument", bgSize: [451, 540],
      sheet: "teamguy", fps: 6,
      anims: {
        walk_down: [[180,376,198,413],[201,376,219,413],[222,376,240,413]],
        walk_left: [[185,416,201,453],[204,416,214,453],[217,416,233,453]],
        walk_right: [[185,456,201,493],[204,456,214,493],[217,456,233,493]],
        walk_up: [[181,496,198,533],[201,496,219,533],[222,496,239,533]]
      },
      idle: [201,376,219,413], battleSheet: "guyBattle", specials: [[119,174,145,236],[189,199,230,235]],
      home: {x:225,y:330}, patrol: [{x:225,y:330},{x:190,y:310},{x:260,y:350},{x:220,y:380}]
    },
    {
      genre: "Indie", id: "ino", name: "Ino Yamanaka", artist: "Phoebe Bridgers", song: "Motion Sickness",
      location: "Konoha Village (Indie recolor)", bg: "town", bgSize: [767, 758], recolorFilter: "hue-rotate(260deg) saturate(115%) brightness(1.03)", recolored: true,
      sheet: "team10", fps: 6,
      anims: {
        walk_down: [[166,117,180,149],[183,117,197,149],[200,117,214,149]],
        walk_left: [[161,152,179,183],[182,152,199,183],[202,152,222,183]],
        walk_right: [[163,186,181,217],[184,186,201,217],[204,186,224,217]],
        walk_up: [[167,220,181,252],[184,220,198,252],[201,220,214,252]]
      },
      idle: [183,117,197,149], battleSheet: "inoBattle", specials: [[107,184,133,239],[179,191,207,239]],
      home: {x:350,y:480}, patrol: [{x:350,y:480},{x:320,y:460},{x:380,y:500},{x:340,y:520}],
      note: "location is Konoha Village recolored, not a distinct map"
    },
    {
      genre: "Soul/Funk", id: "choji", name: "Choji Akimichi", artist: "Stevie Wonder", song: "Superstition",
      location: "Ichiraku Ramen (interior)", bg: "ramenInterior", bgSize: [208, 216],
      sheet: "team10", fps: 5,
      anims: {
        walk_down: [[25,383,45,413],[3,383,22,413],[48,383,67,413]],
        walk_left: [[10,416,24,446],[27,416,41,446],[44,416,59,446]],
        walk_right: [[9,449,23,479],[26,449,40,479],[43,449,58,479]],
        walk_up: [[1,482,20,512],[23,482,43,512],[46,482,65,512]]
      },
      idle: [25,383,45,413], battleSheet: "chojiBattle", specials: [[21,15,48,55],[76,152,114,194]],
      home: {x:100,y:140}, patrol: [{x:100,y:140},{x:80,y:120},{x:130,y:150},{x:95,y:170}]
    },
    {
      genre: "Latin", id: "tenten", name: "Tenten", artist: "Bad Bunny", song: "Titítí Me Preguntó",
      location: "Konoha Village (Latin recolor)", bg: "town", bgSize: [767, 758], recolorFilter: "hue-rotate(-25deg) saturate(160%) brightness(1.05)", recolored: true,
      sheet: "teamguy", fps: 6,
      anims: {
        walk_down: [[33,135,45,167],[18,135,30,167],[48,135,61,167]],
        walk_left: [[35,168,47,198],[20,168,32,198],[50,168,63,198]],
        walk_right: [[33,201,47,233],[16,201,30,233],[50,201,64,233]],
        walk_up: [[33,135,45,167],[18,135,30,167],[48,135,61,167]]
      },
      idle: [33,135,45,167], battleSheet: "tentenBattle", specials: [[107,182,138,228],[202,192,242,228]],
      home: {x:150,y:620}, patrol: [{x:150,y:620},{x:120,y:600},{x:180,y:640},{x:140,y:660}],
      note: "walk_up mirrors walk_down (no back sprite on this sheet); location is Konoha Village recolored"
    },
    {
      genre: "Classical", id: "temari", name: "Temari", artist: "Ludovico Einaudi", song: "Nuvole Bianche",
      location: "Konoha Village (Classical recolor)", bg: "town", bgSize: [767, 758], recolorFilter: "sepia(0.3) saturate(115%) brightness(1.1) contrast(0.95)", recolored: true,
      sheet: "sand", fps: 6,
      anims: {
        walk_down: [[238,154,254,188],[257,154,272,188],[275,154,291,188]],
        walk_left: [[240,190,256,224],[259,190,274,224],[277,190,293,224]],
        walk_right: [[238,227,254,261],[257,227,273,261],[276,227,292,261]],
        walk_up: [[230,268,250,306],[253,268,272,306],[272,268,291,306]]
      },
      idle: [257,154,272,188], battleSheet: "temariBattle", specials: [[10,7,46,64],[78,141,126,193]],
      home: {x:510,y:110}, patrol: [{x:510,y:110},{x:480,y:90},{x:540,y:130},{x:500,y:150}],
      note: "location is Konoha Village recolored, not a distinct map"
    },
    {
      genre: "Metalcore", id: "kankuro", name: "Kankuro", artist: "Bring Me the Horizon", song: "Can You Feel My Heart",
      location: "Konoha Village (Metalcore recolor)", bg: "town", bgSize: [767, 758], recolorFilter: "grayscale(0.65) contrast(1.35) brightness(0.82)", recolored: true,
      sheet: "sand", fps: 6,
      anims: {
        walk_down: [[391,160,411,193],[414,160,433,193],[436,160,456,193]],
        walk_left: [[392,196,412,229],[415,196,434,229],[437,196,457,229]],
        walk_right: [[395,232,411,264],[414,232,430,264],[433,232,449,264]],
        walk_up: [[391,160,411,193],[414,160,433,193],[436,160,456,193]]
      },
      idle: [414,160,433,193], battleSheet: "kankuroBattle", specials: [[101,201,158,260],[228,199,290,260]],
      home: {x:645,y:615}, patrol: [{x:645,y:615},{x:615,y:630},{x:670,y:640},{x:630,y:590}],
      note: "walk_up mirrors walk_down (no back sprite on this sheet); location is Konoha Village recolored"
    }
  ];

  // Expose data for the Node-based asset/bounds verification script (verify.js)
  // and skip all browser/DOM runtime code when required from Node.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { DISTRICTS: DISTRICTS, IMAGE_FILES: IMAGE_FILES };
    return;
  }

  // ---------------------------------------------------------------------
  // NPC runtime state — one per district, lazily created and kept alive so
  // switching districts and back preserves position/animation.
  // ---------------------------------------------------------------------
  function makeNPC(def) {
    return {
      def: def,
      x: def.patrol[0].x,
      y: def.patrol[0].y,
      patrolIdx: 0,
      dir: "down",
      state: "idle", // idle | walk | traveling_home | performing | traveling_back
      frame: 0,
      frameTimer: 0,
      idleTimer: 1 + Math.random() * 2,
      caption: null,
      captionTimer: 0,
      performTimer: 0,
      performFrame: 0,
      returnAfterPerform: null,
      lastNowPlaying: 0
    };
  }

  var npcs = DISTRICTS.map(makeNPC);
  var currentIdx = 0;

  // ---------------------------------------------------------------------
  // Canvas / DOM setup
  // ---------------------------------------------------------------------
  var canvas = document.getElementById("game");
  var ctx = canvas.getContext("2d");
  var stage = document.getElementById("stage");
  var select = document.getElementById("districtSelect");
  var prevBtn = document.getElementById("prevBtn");
  var nextBtn = document.getElementById("nextBtn");
  var label = document.getElementById("districtLabel");
  var recolorNote = document.getElementById("recolorNote");

  DISTRICTS.forEach(function (d, i) {
    var opt = document.createElement("option");
    opt.value = i;
    opt.textContent = d.genre + " — " + d.name;
    select.appendChild(opt);
  });

  var currentScale = 2;

  function applyDistrict(i) {
    if (showAll) setShowAll(false);
    if (villageMode) setVillage(false);
    currentIdx = (i + DISTRICTS.length) % DISTRICTS.length;
    var d = DISTRICTS[currentIdx];
    var w = d.bgSize[0], h = d.bgSize[1];
    currentScale = Math.max(1, Math.min(SCALE_MAX, Math.floor(SCALE_TARGET_WIDTH / w)));
    canvas.width = w;
    canvas.height = h;
    stage.style.width = "min(100%, " + (w * currentScale) + "px)";
    select.value = currentIdx;
    label.textContent = d.genre + " district — " + d.location;
    recolorNote.textContent = d.recolored
      ? "(Konoha Village recolored to stand in for this genre — see report)"
      : "";
    card.style.display = "none";
  }

  select.addEventListener("change", function () { applyDistrict(parseInt(select.value, 10)); });
  prevBtn.addEventListener("click", function () { applyDistrict(currentIdx - 1); });
  nextBtn.addEventListener("click", function () { applyDistrict(currentIdx + 1); });

  ctx.imageSmoothingEnabled = false;

  // ---------------------------------------------------------------------
  // Update logic
  // ---------------------------------------------------------------------
  var WALK_SPEED = 22; // px/sec in world space
  var NOW_PLAYING_INTERVAL = 8000; // ms

  function pickDir(dx, dy) {
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
    return dy > 0 ? "down" : "up";
  }

  function startPerform(npc, andThen) {
    npc.state = "performing";
    npc.performTimer = 0;
    npc.performFrame = 0;
    npc.returnAfterPerform = andThen || null;
  }

  function setCaption(npc, text, seconds) {
    npc.caption = text;
    npc.captionTimer = seconds;
  }

  function updateNPC(npc, dt, now, isActive) {
    var def = npc.def;

    if (isActive && now - npc.lastNowPlaying > NOW_PLAYING_INTERVAL &&
        (npc.state === "idle" || npc.state === "walk")) {
      npc.lastNowPlaying = now;
      npc.state = "traveling_home";
    }

    if (npc.captionTimer > 0) {
      npc.captionTimer -= dt;
      if (npc.captionTimer <= 0) npc.caption = null;
    }

    if (npc.state === "performing") {
      npc.performTimer += dt;
      var perFrameTime = 0.45;
      npc.performFrame = Math.floor(npc.performTimer / perFrameTime) % def.specials.length;
      if (npc.performTimer >= perFrameTime * def.specials.length * 1.6) {
        npc.state = npc.returnAfterPerform || "idle";
        npc.returnAfterPerform = null;
      }
      return;
    }

    if (npc.state === "traveling_home") {
      var tx = def.home.x, ty = def.home.y;
      var ddx = tx - npc.x, ddy = ty - npc.y;
      var dist = Math.sqrt(ddx * ddx + ddy * ddy);
      if (dist < 2) {
        npc.x = tx; npc.y = ty;
        setCaption(npc, "Now playing: " + def.artist + " – " + def.song, 3.2);
        startPerform(npc, "traveling_back");
      } else {
        npc.dir = pickDir(ddx, ddy);
        var step = WALK_SPEED * dt;
        if (step > dist) step = dist;
        npc.x += (ddx / dist) * step;
        npc.y += (ddy / dist) * step;
        npc.frameTimer += dt;
        var ft = 1 / def.fps;
        if (npc.frameTimer >= ft) { npc.frameTimer -= ft; npc.frame = (npc.frame + 1) % 3; }
      }
      return;
    }

    if (npc.state === "traveling_back") {
      var home = def.patrol[0];
      var bdx = home.x - npc.x, bdy = home.y - npc.y;
      var bdist = Math.sqrt(bdx * bdx + bdy * bdy);
      if (bdist < 2) {
        npc.state = "idle";
        npc.idleTimer = 1 + Math.random() * 2;
      } else {
        npc.dir = pickDir(bdx, bdy);
        var step2 = WALK_SPEED * dt;
        if (step2 > bdist) step2 = bdist;
        npc.x += (bdx / bdist) * step2;
        npc.y += (bdy / bdist) * step2;
        npc.frameTimer += dt;
        var ft2 = 1 / def.fps;
        if (npc.frameTimer >= ft2) { npc.frameTimer -= ft2; npc.frame = (npc.frame + 1) % 3; }
      }
      return;
    }

    if (npc.state === "idle") {
      npc.idleTimer -= dt;
      if (npc.idleTimer <= 0) {
        npc.patrolIdx = (npc.patrolIdx + 1) % def.patrol.length;
        npc.state = "walk";
      }
      if (isActive && Math.random() < 0.0006) {
        startPerform(npc, "idle");
        setCaption(npc, def.name.split(" ")[0] + " is vibing to " + def.artist, 2.4);
      }
      return;
    }

    if (npc.state === "walk") {
      var target = def.patrol[npc.patrolIdx];
      var wdx = target.x - npc.x, wdy = target.y - npc.y;
      var wdist = Math.sqrt(wdx * wdx + wdy * wdy);
      if (wdist < 2) {
        npc.state = "idle";
        npc.idleTimer = 1 + Math.random() * 2.5;
      } else {
        npc.dir = pickDir(wdx, wdy);
        var step3 = WALK_SPEED * dt;
        if (step3 > wdist) step3 = wdist;
        npc.x += (wdx / wdist) * step3;
        npc.y += (wdy / wdist) * step3;
        npc.frameTimer += dt;
        var ft3 = 1 / def.fps;
        if (npc.frameTimer >= ft3) { npc.frameTimer -= ft3; npc.frame = (npc.frame + 1) % 3; }
      }
    }
  }

  function tick(now, dt) {
    npcs.forEach(function (n, i) { updateNPC(n, dt, now, i === currentIdx); });
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function drawNPC(npc) {
    var def = npc.def;
    var img, rect;

    if (npc.state === "performing") {
      img = images[def.battleSheet];
      rect = def.specials[npc.performFrame % def.specials.length];
    } else if (npc.state === "idle") {
      img = images[def.sheet];
      rect = def.idle;
    } else {
      img = images[def.sheet];
      var animKey = "walk_" + npc.dir;
      var frames = def.anims[animKey] || def.anims.walk_down;
      rect = frames[npc.frame % frames.length];
    }

    var sx = rect[0], sy = rect[1], sw = rect[2] - rect[0], sh = rect[3] - rect[1];
    var dw = sw, dh = sh;
    var dx = Math.round(npc.x - dw / 2);
    var dy = Math.round(npc.y - dh);
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);

    if (npc.caption) {
      ctx.save();
      ctx.font = "9px monospace";
      ctx.textAlign = "center";
      var text = npc.caption;
      var maxW = Math.min(150, canvas.width - 12);
      var words = text.split(" ");
      var lines = [];
      var line = "";
      words.forEach(function (w) {
        var test = line ? line + " " + w : w;
        if (ctx.measureText(test).width > maxW && line) {
          lines.push(line);
          line = w;
        } else {
          line = test;
        }
      });
      if (line) lines.push(line);
      var boxW = Math.min(maxW, Math.max.apply(null, lines.map(function (l) { return ctx.measureText(l).width; }))) + 10;
      var boxH = lines.length * 11 + 6;
      var bx = Math.max(boxW / 2 + 2, Math.min(canvas.width - boxW / 2 - 2, npc.x));
      var by = Math.max(2, dy - boxH - 6);
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.strokeStyle = "#333";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(bx - boxW / 2, by, boxW, boxH);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#111";
      lines.forEach(function (l, i) {
        ctx.fillText(l, bx, by + 4 + i * 11);
      });
      ctx.restore();
    }
  }

  function render() {
    var d = DISTRICTS[currentIdx];
    var npc = npcs[currentIdx];
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    if (d.recolorFilter) ctx.filter = d.recolorFilter;
    ctx.drawImage(images[d.bg], 0, 0);
    ctx.restore();

    if (d.recolorFilter) ctx.filter = d.recolorFilter;
    drawNPC(npc);
    ctx.filter = "none";
  }

  // ---------------------------------------------------------------------
  // Click -> info card
  // ---------------------------------------------------------------------
  var card = document.getElementById("card");
  var cardName = document.getElementById("cardName");
  var cardArtist = document.getElementById("cardArtist");
  var cardBody = document.getElementById("cardBody");
  document.getElementById("cardClose").addEventListener("click", function () {
    card.style.display = "none";
  });

  canvas.addEventListener("click", function (ev) {
    var r = canvas.getBoundingClientRect();
    var wx = (ev.clientX - r.left) * (canvas.width / r.width);
    var wy = (ev.clientY - r.top) * (canvas.height / r.height);
    var half = 22;
    var pool = villageMode ? villageNPCs : [npcs[currentIdx]];
    var hit = null;
    pool.forEach(function (npc) {
      if (wx > npc.x - half && wx < npc.x + half && wy > npc.y - 40 && wy < npc.y + 10) hit = npc;
    });
    if (hit) {
      var def = hit.def;
      cardName.textContent = def.name;
      cardArtist.textContent = "plays as " + def.artist + " • " + def.genre + " • " + def.location;
      cardBody.innerHTML =
        "Now playing: <em>" + def.song + "</em><br>" +
        "State: " + hit.state +
        (def.note ? "<br><span style='color:#e2a4a4'>Note: " + def.note + "</span>" : "");
      var k = r.width / canvas.width;
      card.style.display = "block";
      var cw = card.offsetWidth;
      card.style.left = Math.max(4, Math.min(r.width - cw - 4, hit.x * k - cw / 2)) + "px";
      card.style.top = Math.max(4, (hit.y - 70) * k) + "px";
    } else {
      card.style.display = "none";
    }
  });

  // ---------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------
  var lastTs = null;
  function frame(ts) {
    if (lastTs === null) lastTs = ts;
    var dt = Math.min(0.05, (ts - lastTs) / 1000);
    lastTs = ts;
    tick(ts, dt);
    if (villageMode) { tickVillage(ts, dt); renderVillage(); }
    else if (showAll) renderRoster(ts); else render();
    requestAnimationFrame(frame);
  }

  // All-characters roster: every genre character animating side by side.
  var roster = document.getElementById("roster");
  var allBtn = document.getElementById("allBtn");
  var rosterCells = [];
  var showAll = false;
  var DIRS = ["down", "left", "up", "right"];
  function buildRoster() {
    DISTRICTS.forEach(function (d, i) {
      var cell = document.createElement("div");
      cell.className = "rcell";
      var c = document.createElement("canvas");
      c.width = 64; c.height = 64;
      var b = document.createElement("b"); b.textContent = d.genre;
      var sp = document.createElement("span"); sp.textContent = d.name;
      cell.appendChild(c); cell.appendChild(b); cell.appendChild(sp);
      cell.addEventListener("click", function () { setShowAll(false); applyDistrict(i); });
      roster.appendChild(cell);
      rosterCells.push({ def: d, ctx: c.getContext("2d"), offset: Math.random() * 6 });
    });
  }
  function setShowAll(on) {
    showAll = on;
    roster.hidden = !on;
    stage.hidden = on;
    label.hidden = on; recolorNote.hidden = on;
    allBtn.classList.toggle("on", on);
    allBtn.textContent = on ? "Back to district" : "All characters";
  }
  allBtn.addEventListener("click", function () {
    if (villageMode) { villageMode = false; villageBtn.classList.remove("on"); villageBtn.textContent = "Whole village"; }
    setShowAll(!showAll);
  });
  function renderRoster(ts) {
    var t = ts / 1000;
    rosterCells.forEach(function (rc) {
      var d = rc.def, cx = rc.ctx, lt = t + rc.offset;
      var cycle = lt % 8, img, rect;
      if (cycle > 6.5) {
        img = images[d.battleSheet];
        rect = d.specials[Math.floor((cycle - 6.5) / 0.45) % d.specials.length];
      } else {
        img = images[d.sheet];
        var frames = d.anims["walk_" + DIRS[Math.floor(cycle / 1.625) % 4]];
        rect = frames[Math.floor(lt * d.fps) % frames.length];
      }
      var sw = rect[2] - rect[0], sh = rect[3] - rect[1];
      var k = Math.min(1, 60 / sw, 60 / sh);
      cx.imageSmoothingEnabled = false;
      cx.clearRect(0, 0, 64, 64);
      cx.drawImage(img, rect[0], rect[1], sw, sh, Math.round(32 - sw * k / 2), Math.round(62 - sh * k), sw * k, sh * k);
    });
  }

  // Whole village: all 17 characters walking together on the Konoha map.
  // Anchors are spots already validated as walkable in the recolored districts.
  var villageBtn = document.getElementById("villageBtn");
  var villageMode = false;
  var ANCHORS = [[495,690],[320,350],[300,150],[150,100],[90,460],[650,300],[350,480],[150,620],[510,110],[645,615]];
  var villageNPCs = DISTRICTS.map(function (d, i) {
    var a = ANCHORS[i % ANCHORS.length];
    var off = i >= ANCHORS.length ? 34 : 0;
    var home = { x: a[0] + off, y: a[1] + (off ? 12 : 0) };
    var def = Object.assign({}, d, {
      home: home,
      patrol: [home, { x: home.x - 30, y: home.y - 15 }, { x: home.x + 30, y: home.y + 10 }, { x: home.x - 10, y: home.y + 25 }]
    });
    var n = makeNPC(def);
    n.x = home.x; n.y = home.y;
    return n;
  });
  var lastVillageEvent = 0;
  function setVillage(on) {
    villageMode = on;
    if (on && showAll) setShowAll(false);
    villageBtn.classList.toggle("on", on);
    villageBtn.textContent = on ? "Back to district" : "Whole village";
    card.style.display = "none";
    if (on) {
      canvas.width = 767; canvas.height = 758;
      stage.style.width = "min(100%, 767px)";
      label.textContent = "Konoha Village — all 17 genres";
      recolorNote.textContent = "";
    } else {
      applyDistrict(currentIdx);
    }
  }
  villageBtn.addEventListener("click", function () { setVillage(!villageMode); });
  function tickVillage(now, dt) {
    if (now - lastVillageEvent > 5000) {
      lastVillageEvent = now;
      var n = villageNPCs[Math.floor(Math.random() * villageNPCs.length)];
      if (n.state === "idle" || n.state === "walk") {
        setCaption(n, "Now playing: " + n.def.artist + " – " + n.def.song, 3.2);
        startPerform(n, "idle");
      }
    }
    villageNPCs.forEach(function (n) { updateNPC(n, dt, now, false); });
  }
  function renderVillage() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(images.town, 0, 0);
    villageNPCs.slice().sort(function (a, b) { return a.y - b.y; }).forEach(function (n) {
      if (n.caption) return;
      drawNPC(n);
    });
    villageNPCs.forEach(function (n) { if (n.caption) drawNPC(n); });
  }

  loadImages(function () {
    buildRoster();
    applyDistrict(0);
    requestAnimationFrame(frame);
  });
})();
