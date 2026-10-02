/**
 * SHOWBOARD — the screenshot stage at /tools/showboard.
 *
 * Drop in screenshots, lay them out, set the camera, export at any size up to
 * what the GPU can render (3200x1800 to start).
 * Everything happens in the browser: images are read with FileReader and the export
 * comes off the canvas. Nothing is uploaded.
 *
 * PORTED FROM A STANDALONE PAGE (29 Sep 2026) and kept close to it on purpose, so the
 * two can be compared line by line. What changed:
 *  - three is the site's own (npm), not r128 off a CDN. Two renames that brings:
 *    `outputEncoding` is gone (sRGB output is the default now) and a texture's
 *    `encoding = sRGBEncoding` is `colorSpace = SRGBColorSpace`. Colours set from hex
 *    are colour-managed both ways since r152, so the picture is unchanged.
 *  - Elements are found inside the mount root by `sb-` ids (see showboard.twig).
 *  - Window listeners, the render loop and the renderer are released by dispose().
 */
import * as THREE from 'three';

export function mountShowboard(root) {
  var listeners = [];
  var raf = 0;
  function on(target, type, fn, opts){ target.addEventListener(type, fn, opts); listeners.push([target, type, fn, opts]); }


  /* ───────── state ───────── */
  // THE STARTING STATE IS THE FLAT LAY PRESET (Jon, 29 Sep 2026): screenshots arrive
  // flat, seen from above. Its camera and spacing values are copied from PRESETS.flat
  // below — keep the two in step. Reset returns here too.
  var DEFAULTS = {
    cols:0, repeat:1, masonry:true, shuffle:false, seed:1, gap:0.22, depth:1, stagger:0,
    matchw:false, tilt:0, spin:0, radius:2, shadow:0, // matchw and shadow off by default (Jon, 29 Sep 2026)
    yaw:0, pitch:89, fov:22, zoom:1.02,
    bg:'#ffffff', alpha:false,
    fill:'solid', bg2:'#d6dbe3', angle:180, spread:100, // Fill: solid, or a gradient on the floor (Jon, 2 Oct 2026)
    outW:3200, outH:1800 // the export size (Size section) — its shape frames everything
  };
  var S = Object.assign({}, DEFAULTS);
  var shots = [];          // {id,name,img,w,h,tex,mat}
  var nextId = 1;
  var needsRender = true;
  var needsBuild = true;

  var $ = function(id){ return root.querySelector('#sb-' + id); };
  var canvas = $('view');

  /* ───────── three.js setup ───────── */
  var renderer = new THREE.WebGLRenderer({
    canvas: canvas, antialias: true, alpha: true, preserveDrawingBuffer: true
  });
    var maxAniso = renderer.capabilities.getMaxAnisotropy();
  var isGL2 = true; // three r163+ is WebGL 2 only

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(35, 16/9, 0.01, 4000);

  var itemsGroup = new THREE.Group();
  var shadowGroup = new THREE.Group();
  scene.add(shadowGroup);
  scene.add(itemsGroup);

  // THE GRADIENT FLOOR (Jon, 2 Oct 2026) — only while Fill is Linear or Radial, and never
  // with Transparent on: the floor removed on 29 Sep (below) hid the Background colour
  // and made transparent PNGs opaque, and a solid fill still has no floor. It lies under
  // the screens and shadows, sized to the FRAME as it meets the floor at the board (a
  // first cut sized it to the board, and the colours turned within a few centimetres of
  // the screens): a linear gradient runs edge to edge at Angle (CSS's sense: 180° runs
  // top to bottom in a flat lay), a radial one from the centre to the frame's corners. The colours are mixed as sRGB, as
  // CSS mixes them, and written straight out; a little noise keeps wide, close colours
  // from banding.
  var floorMat = new THREE.ShaderMaterial({
    uniforms: {
      uA: { value: new THREE.Vector3(1, 1, 1) },
      uB: { value: new THREE.Vector3(1, 1, 1) },
      uRadial: { value: 0 },
      uCentre: { value: new THREE.Vector2() },
      uHalf: { value: new THREE.Vector2(1, 1) },
      uAxis: { value: new THREE.Vector2(1, 0) },
      uSpread: { value: 1 },
      uDir: { value: new THREE.Vector2(0, 1) }
    },
    vertexShader: [
      'varying vec2 vW;',
      'void main(){',
      '  vec4 w = modelMatrix * vec4(position, 1.0);',
      '  vW = w.xz;',
      '  gl_Position = projectionMatrix * viewMatrix * w;',
      // Pinned inside the depth range so the far floor is never cut off, without
      // stretching the camera's range (see placeCamera): nothing depth-tests against it.
      '  gl_Position.z = clamp(gl_Position.z, -gl_Position.w * 0.999, gl_Position.w * 0.999);',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 uA; uniform vec3 uB; uniform float uRadial;',
      'uniform vec2 uCentre; uniform vec2 uHalf; uniform vec2 uAxis; uniform vec2 uDir; uniform float uSpread;',
      'varying vec2 vW;',
      'void main(){',
      '  vec2 p = vW - uCentre;',
      // How far the frame reaches along the gradient: its half-width along the frame's
      // own across (uAxis, the camera's right laid on the floor) and half-height along
      // the perpendicular, each projected onto the direction.
      '  vec2 down = vec2(-uAxis.y, uAxis.x);',
      '  float ext = abs(dot(uDir, uAxis)) * uHalf.x + abs(dot(uDir, down)) * uHalf.y;',
      '  float t = uRadial > 0.5 ? length(p) / (length(uHalf) * uSpread) : dot(p, uDir) / (2.0 * ext) + 0.5;',
      '  t = clamp(t, 0.0, 1.0);',
      '  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;',
      '  gl_FragColor = vec4(mix(uA, uB, t) + n / 255.0, 1.0);',
      '}'
    ].join('\n'),
    depthTest: false,
    depthWrite: false // drawn first (renderOrder), so everything simply lands on it
  });
  var floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.003; // under the shadows (0.0015) and the screens
  floor.renderOrder = -2;
  floor.visible = false;
  scene.add(floor);
  var FLOOR_REACH = 60; // the floor runs this many frame-widths out: past every edge

  function hexToVec(hex, v){
    var n = parseInt(hex.slice(1), 16);
    return v.set((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255);
  }

  // The gradient's direction on the floor: CSS's angle, with the flat lay's "up" as -z.
  function fillDir(){
    var a = S.angle * Math.PI / 180;
    return floorMat.uniforms.uDir.value.set(Math.sin(a), -Math.cos(a));
  }

  function syncFloor(){
    floor.visible = S.fill !== 'solid' && !S.alpha && itemsGroup.children.length > 0;
    if (!floor.visible) return;
    var u = floorMat.uniforms;
    hexToVec(S.bg, u.uA.value);
    hexToVec(S.bg2, u.uB.value);
    u.uRadial.value = S.fill === 'radial' ? 1 : 0;
    u.uSpread.value = S.spread / 100; // radial Size: 100% reaches the frame's corners
    fillDir();
    u.uCentre.value.set(frameOnFloor.x, frameOnFloor.z);
    u.uHalf.value.set(Math.max(0.05, frameOnFloor.w), Math.max(0.05, frameOnFloor.h));
    var right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    u.uAxis.value.set(right.x, right.z);
    if (u.uAxis.value.lengthSq() < 1e-6) u.uAxis.value.set(1, 0);
    u.uAxis.value.normalize();
    var size = Math.max(u.uHalf.value.x, u.uHalf.value.y) * 2 * FLOOR_REACH;
    floor.scale.set(size, size, 1);
    floor.position.x = u.uCentre.value.x;
    floor.position.z = u.uCentre.value.y;
  }

  // NO FLOOR (Jon, 29 Sep 2026). There was a 600-unit plane under everything with a
  // colour of its own, and it covered the canvas from almost every angle: the
  // Background colour did nothing in a flat lay, and a "transparent" PNG came out
  // opaque. Now the canvas is the backdrop — one Background colour, white to start, or
  // cleared for transparency, which the frame's checkerboard shows through. Shadows
  // are their own meshes (shadowGroup) and do not need a floor to land on.

  /* ───────── texture helpers ───────── */
  function roundRectPath(ctx,x,y,w,h,r){
    r = Math.max(0, Math.min(r, w/2, h/2));
    ctx.beginPath();
    ctx.moveTo(x+r,y);
    ctx.arcTo(x+w,y,x+w,y+h,r);
    ctx.arcTo(x+w,y+h,x,y+h,r);
    ctx.arcTo(x,y+h,x,y,r);
    ctx.arcTo(x,y,x+w,y,r);
    ctx.closePath();
  }

  function makeTexture(shot){
    var MAX = 1800;
    var scale = Math.min(1, MAX / Math.max(shot.w, shot.h));
    var w = Math.max(2, Math.round(shot.w * scale));
    var h = Math.max(2, Math.round(shot.h * scale));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    // Square: the corners are rounded in the shader (roundCorners), so the radius
    // slider never redraws this.
    ctx.drawImage(shot.img, 0, 0, w, h);

    var t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    if (isGL2){
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
    } else {
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearFilter;
    }
    t.magFilter = THREE.LinearFilter;
    if (shot.tex) shot.tex.dispose();
    shot.tex = t;
  }

  var shadowCache = {};
  function shadowTexture(aspect){
    var key = aspect.toFixed(2);
    if (shadowCache[key]) return shadowCache[key];
    var W = 256, H = Math.max(32, Math.round(256/Math.max(aspect,0.01)));
    if (H > 512){ H = 512; W = Math.max(32, Math.round(512*aspect)); }
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var ctx = c.getContext('2d');
    var pad = Math.round(Math.min(W,H) * 0.22);
    ctx.filter = 'blur(' + Math.round(pad*0.55) + 'px)';
    ctx.fillStyle = '#000';
    roundRectPath(ctx, pad, pad, W-pad*2, H-pad*2, Math.min(W,H)*0.08);
    ctx.fill();
    var t = new THREE.CanvasTexture(c);
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    shadowCache[key] = t;
    return t;
  }

  /* ───────── scene build ───────── */
  // SHARED, NOT PER TILE. Every tile is one unit plane scaled to its size, wearing its
  // screenshot's own material; every shadow one unit plane and a material per look. A
  // rebuild used to make a geometry and a material for every tile — 1,000 of each at
  // 100 screenshots ×10 — and three.js re-derived its shader setup for each one, every
  // slider step. clearGroup also dropped the tile's wrapper group without disposing
  // the mesh inside it, so all of that stayed on the GPU. Now a rebuild only moves
  // meshes around; materials are made when a texture or the look changes.
  var tileGeo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  var shadowGeo = new THREE.PlaneGeometry(1, 1);
  var shadowMats = {}; // texture uuid + opacity -> material, rebuilt with each build

  function shotMaterial(s){
    if (!s.mat || s.mat.map !== s.tex){
      if (s.mat) s.mat.dispose();
      s.mat = new THREE.MeshBasicMaterial({ map: s.tex, side: THREE.DoubleSide, transparent: S.radius > 0 });
      roundCorners(s.mat, s.w / s.h);
    }
    return s.mat;
  }

  // ROUND CORNERS IN THE SHADER (Jon, 2 Oct 2026: radius "feels laggy" at 18 ×10). The
  // corners used to be clipped into each screenshot's texture, so every step of the
  // slider redrew and re-uploaded every texture and rebuilt the board. Now one uniform
  // carries the radius to every material: a step is a single redraw. Same shape as the
  // clip it replaces — radius as a share of the shorter side — with the edge smoothed
  // over one screen pixel.
  var radiusU = { value: S.radius / 100 };
  var roundedNow = S.radius > 0;
  function roundCorners(mat, aspect){
    mat.onBeforeCompile = function(sh){
      sh.uniforms.uRadius = radiusU;
      sh.uniforms.uAspect = { value: aspect };
      sh.fragmentShader = 'uniform float uRadius;\nuniform float uAspect;\n' + sh.fragmentShader.replace(
        '#include <opaque_fragment>',
        [
          '{',
          '  vec2 halfSize = vec2(uAspect, 1.0) * 0.5;',
          '  vec2 p = (vMapUv - 0.5) * vec2(uAspect, 1.0);',
          '  float rad = uRadius * min(uAspect, 1.0);',
          '  float d = length(max(abs(p) - halfSize + rad, 0.0)) - rad;',
          '  float aa = fwidth(d);',
          '  diffuseColor.a *= 1.0 - smoothstep(-aa, aa, d);',
          '}',
          '#include <opaque_fragment>'
        ].join('\n')
      );
    };
    mat.customProgramCacheKey = function(){ return 'showboard-rounded'; };
  }

  // The uniform follows the slider; crossing zero turns blending on or off, as the
  // texture's transparent corners did.
  function syncRadius(){
    radiusU.value = S.radius / 100;
    var rounded = S.radius > 0;
    if (rounded !== roundedNow){
      roundedNow = rounded;
      shots.forEach(function(s){ if (s.mat){ s.mat.transparent = rounded; s.mat.needsUpdate = true; } });
    }
  }

  function disposeShot(s){
    if (s.tex) s.tex.dispose();
    if (s.mat) s.mat.dispose();
    s.tex = s.mat = null;
  }

  function clearGroup(g){
    g.clear();
  }

  function clearShadowMats(){
    Object.keys(shadowMats).forEach(function(k){ shadowMats[k].dispose(); });
    shadowMats = {};
  }

  function shadowMaterial(tex, opacity){
    var key = tex.uuid + '|' + opacity.toFixed(4);
    if (!shadowMats[key]){
      shadowMats[key] = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: opacity, depthWrite: false, color: 0x000000
      });
    }
    return shadowMats[key];
  }

  function columnsFor(n){
    if (S.cols > 0) return Math.min(S.cols, n);
    return Math.max(1, Math.round(Math.sqrt(n * aspect())));
  }

  function mulberry32(a){
    return function(){
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  var seqCache = { key:'', seq:null };

  // Decides which screenshot lands in which cell.
  // ONE copy of each pinned screenshot claims a cell nearest the centre; its other
  // copies are dealt with everything else (29 Sep 2026: with Repeat ×10 all ten copies
  // were pinned, so they clumped in the middle and the shuffle could not move them).
  // Which cells hold the pinned copy is kept in seqCache.pin, per cell.
  // Shuffling avoids putting the same screen in neighbouring cells.
  function makeSequence(n, base, repeat, cols){
    var key = [n, base, repeat, cols, S.shuffle ? S.seed : 0, S.shuffle].join('|') +
              '|' + shots.map(function(s){ return s.hero ? 1 : 0; }).join('');
    if (seqCache.key === key) return seqCache.seq;

    var assign = [], pin = [], i;
    for (i=0;i<n;i++){ assign.push(-1); pin.push(0); }

    var heroes = [], fills = [];
    for (var b=0;b<base;b++){ (shots[b].hero ? heroes : fills).push(b); }

    if (!heroes.length && !S.shuffle){
      for (i=0;i<n;i++) assign[i] = i % base;
      seqCache = { key:key, seq:assign, pin:pin };
      return assign;
    }

    var rows = Math.ceil(n / cols);
    var cells = [];
    for (i=0;i<n;i++){
      var dx = (i % cols) - (cols-1)/2;
      var dz = Math.floor(i/cols) - (rows-1)/2;
      cells.push({ i:i, d: dx*dx + dz*dz*1.4 }); // depth weighted: front-to-back centring reads stronger
    }
    cells.sort(function(a,b){ return a.d - b.d || a.i - b.i; });

    var rng = mulberry32(S.seed * 2654435761 + n * 7919 + cols * 104729);
    var pending = cells.slice(); // still-free cells, most central first

    // `copies` maps screenshot -> how many of it this pool deals.
    function placePool(copies, pinIt){
      var pool = Object.keys(copies).map(Number).filter(function(s){ return copies[s] > 0; });
      if (!pool.length) return;
      var need = 0;
      pool.forEach(function(s){ need += copies[s]; });

      if (!S.shuffle){
        // In screenshot order, round and round, skipping any that have run out.
        var order = [], left = {}, r;
        pool.forEach(function(s){ left[s] = copies[s]; });
        while (order.length < need){
          for (r=0;r<pool.length;r++) if (left[pool[r]] > 0){ order.push(pool[r]); left[pool[r]]--; }
        }
        var take = pending.splice(0, need);
        take.sort(function(a,b){ return a.i - b.i; });
        take.forEach(function(cell, k){ assign[cell.i] = order[k]; if (pinIt) pin[cell.i] = 1; });
        return;
      }

      var remain = {}, skipped = [];
      pool.forEach(function(s){ remain[s] = copies[s]; });

      while (need > 0 && pending.length){
        var cell = pending.shift();
        var at = cell.i, banned = {};
        [ (at % cols) ? at-1 : -1,
          ((at+1) % cols) ? at+1 : -1,
          at - cols,
          at + cols
        ].forEach(function(nb){
          if (nb >= 0 && nb < n && assign[nb] >= 0) banned[assign[nb]] = 1;
        });

        var best = [], bestN = -1, s;
        for (s in remain){
          if (remain[s] <= 0 || banned[s]) continue;
          if (remain[s] > bestN){ bestN = remain[s]; best = [s]; }
          else if (remain[s] === bestN) best.push(s);
        }

        // nothing fits here without touching its twin — leave the cell for the next pool
        if (!best.length){
          if (pending.length >= need){ skipped.push(cell); continue; }
          for (s in remain) if (remain[s] > 0) best.push(s);
        }

        var pick = +best[Math.floor(rng() * best.length)];
        assign[at] = pick;
        if (pinIt) pin[at] = 1;
        remain[pick] -= 1;
        need--;
      }
      pending = skipped.concat(pending);
    }

    var heroCopies = {}, fillCopies = {};
    heroes.forEach(function(s){ heroCopies[s] = 1; fillCopies[s] = repeat - 1; });
    fills.forEach(function(s){ fillCopies[s] = repeat; });
    placePool(heroCopies, true);
    placePool(fillCopies, false);

    for (i=0;i<n;i++) if (assign[i] < 0) assign[i] = i % base;

    // Greedy tidy-up: swap same-pool cells while it reduces touching twins.
    if (S.shuffle && base > 1){
      var clashAt = function(a, at){
        var c = 0, v = a[at];
        if (at % cols && a[at-1] === v) c++;
        if ((at+1) % cols && at+1 < n && a[at+1] === v) c++;
        if (at-cols >= 0 && a[at-cols] === v) c++;
        if (at+cols < n && a[at+cols] === v) c++;
        return c;
      };
      var totalClash = function(a){
        var t = 0;
        for (var q=0;q<n;q++) t += clashAt(a, q);
        return t;
      };

      var score = totalClash(assign);
      for (var pass=0; pass<4 && score>0; pass++){
        var moved = false;
        for (i=0;i<n && score>0;i++){
          if (!clashAt(assign, i)) continue;
          for (var j=0;j<n;j++){
            if (j === i || assign[j] === assign[i]) continue;
            if (pin[i] || pin[j]) continue; // keep pinned screens central
            var tmp = assign[i]; assign[i] = assign[j]; assign[j] = tmp;
            var next = totalClash(assign);
            if (next < score){ score = next; moved = true; break; }
            tmp = assign[i]; assign[i] = assign[j]; assign[j] = tmp;
          }
        }
        if (!moved) break;
      }
    }

    seqCache = { key:key, seq:assign, pin:pin };
    return assign;
  }

  function build(){
    clearGroup(itemsGroup);
    clearGroup(shadowGroup);
    clearShadowMats();
    if (!shots.length) return;

    var base = shots.length;
    var repeat = Math.max(1, Math.round(S.repeat));
    var n = base * repeat;
    var cols = columnsFor(n);
    var rows = Math.ceil(n / cols);
    var seq = makeSequence(n, base, repeat, cols);
    var pin = seqCache.pin.slice(); // which cells hold a pinned copy; moves with its screen
    var tilt = S.tilt * Math.PI/180;
    var spin = S.spin * Math.PI/180;
    var ct = Math.cos(tilt);
    var foot = Math.max(ct, 0.35); // standing screens keep a sensible footprint

    // Measure every screen first.
    // Match widths: everything is scaled by one factor, so two screenshots of the
    // same pixel width come out the same width whatever their heights.
    // Otherwise each screen is fitted to a 1×1 box by its longest side.
    // Measured per SCREENSHOT, then looked up per cell: a screen's size depends only on
    // which screenshot it is, so the centring below can reorder cells without
    // measuring again. maxW and maxD depend only on which screenshots are in the set,
    // never on their order, so they are fixed for the whole build.
    var shotDim = [], maxW = 0, maxD = 0, widest = 1, k;
    if (S.matchw){
      for (k=0;k<base;k++) if (shots[k].w > widest) widest = shots[k].w;
    }
    for (k=0;k<base;k++){
      var ks = shots[k];
      var kw, kh;
      if (S.matchw){
        kw = ks.w / widest;
        kh = ks.h / widest;
      } else {
        var ka = ks.w / ks.h;
        kw = ka >= 1 ? 1 : ka;
        kh = ka >= 1 ? 1/ka : 1;
      }
      shotDim.push({ w:kw, h:kh, d:kh*foot });
      if (kw > maxW) maxW = kw;
      if (kh*foot > maxD) maxD = kh*foot;
    }

    var cellX = maxW + S.gap;
    var cellZ = maxD + S.gap * S.depth;
    var gapZ = S.gap * S.depth;
    var dimsOf = function(order){ return order.map(function(sh){ return shotDim[sh]; }); };

    // Masonry drops each screen into the shallowest column, so where cell i ends up
    // depends on everything before it — not on i's place in a grid. Centred on 0,0.
    var masonryPos = function(dims){
      var acc = [], c2, i2, out = [];
      for (c2=0;c2<cols;c2++) acc.push(c2 % 2 ? S.stagger * (maxD + gapZ) * 0.5 : 0);
      for (i2=0;i2<dims.length;i2++){
        var col = 0;
        for (c2=1;c2<cols;c2++) if (acc[c2] < acc[col] - 1e-6) col = c2;
        out.push({ x:(col - (cols-1)/2) * cellX, z: acc[col] + dims[i2].d/2, col: col });
        acc[col] += dims[i2].d + gapZ;
      }
      var longest = 0;
      for (c2=0;c2<cols;c2++) longest = Math.max(longest, acc[c2] - gapZ);
      for (i2=0;i2<out.length;i2++) out[i2].z -= longest/2;
      return out;
    };

    // PINNED SCREENS IN THE MIDDLE OF WHAT IS ACTUALLY DRAWN (29 Sep 2026).
    // makeSequence picks "the most central cell" by counting cells as a grid, which is
    // right for the grid and wrong for masonry: cell 5 of a four-column masonry lands
    // wherever the shortest column is at that moment, and a starred screen ended up on
    // the left edge. So under masonry each pinned screen is tried in every free cell,
    // the real layout is run, and it keeps the cell that lands nearest the centre —
    // one pinned screen at a time, each locking its cell. The distance weights depth
    // as makeSequence does (front-to-back centring reads stronger).
    if (S.masonry && pin.some(Boolean)){
      seq = seq.slice(); // makeSequence's result is cached; never edit it in place
      var locked = {};
      var swapCell = function(x, y){
        var t = seq[x]; seq[x] = seq[y]; seq[y] = t;
        t = pin[x]; pin[x] = pin[y]; pin[y] = t;
      };
      for (;;){
        var h = -1, q;
        for (q=0;q<n;q++) if (!locked[q] && pin[q]){ h = q; break; }
        if (h < 0) break;
        var bestJ = h, bestD = Infinity;
        for (q=0;q<n;q++){
          if (locked[q]) continue;
          var t = seq[h]; seq[h] = seq[q]; seq[q] = t;
          var pq = masonryPos(dimsOf(seq))[q];
          var dq = pq.x*pq.x + pq.z*pq.z*1.4;
          if (dq < bestD - 1e-9){ bestD = dq; bestJ = q; }
          t = seq[h]; seq[h] = seq[q]; seq[q] = t;
        }
        swapCell(h, bestJ);
        locked[bestJ] = 1;
      }
    }
    // NO REPEATS SIDE BY SIDE — ON THE LAYOUT THAT IS ACTUALLY DRAWN (29 Sep 2026).
    // makeSequence's tidy-up judges neighbours as grid cells (left, right, above,
    // below), which masonry does not lay out: the same lanyard shot came out stacked
    // on itself and beside itself. Under masonry, neighbours are read off the real
    // positions instead — the next screen down the same column, and any screen in the
    // column either side that overlaps it in depth or comes within half a screen of
    // doing so (a corner-to-corner twin still reads as a repeat) — and twins are pulled apart by swapping
    // screens of the SAME shape. Same shape means the layout cannot move, so the
    // neighbour map stays true for every swap and this stays cheap at 100+ screens.
    // Pinned screens keep the cells the centring gave them.
    if (S.masonry && S.shuffle && base > 1){
      if (seq === seqCache.seq) seq = seq.slice(); // makeSequence's result is cached; never edit it in place
      var nbrs, a, c;
      var buildNbrs = function(){
        var mp = masonryPos(dimsOf(seq)), mdims = dimsOf(seq), out = [], lastInCol = {}, x, y;
        for (x=0;x<n;x++) out.push([]);
        for (x=0;x<n;x++){
          if (lastInCol[mp[x].col] !== undefined){ out[x].push(lastInCol[mp[x].col]); out[lastInCol[mp[x].col]].push(x); }
          lastInCol[mp[x].col] = x;
        }
        for (x=0;x<n;x++) for (y=x+1;y<n;y++){
          if (Math.abs(mp[x].col - mp[y].col) !== 1) continue;
          var top = Math.max(mp[x].z - mdims[x].d/2, mp[y].z - mdims[y].d/2);
          var bot = Math.min(mp[x].z + mdims[x].d/2, mp[y].z + mdims[y].d/2);
          // Overlapping in depth, or within half a screen of it: a twin one step down
          // the next column touches corner to corner and still reads as a repeat.
          if (bot - top > -maxD * 0.5){ out[x].push(y); out[y].push(x); }
        }
        return out;
      };
      nbrs = buildNbrs();
      var pinned = function(x){ return pin[x]; };
      var clashes = function(x, sh){ var t3 = 0; nbrs[x].forEach(function(y){ if (seq[y] === sh) t3++; }); return t3; };
      var total = function(){ var t5 = 0; for (var z=0;z<n;z++) t5 += clashes(z, seq[z]); return t5; };
      var sameShape = function(x, y){
        return Math.abs(shotDim[seq[x]].d - shotDim[seq[y]].d) < 1e-9 && Math.abs(shotDim[seq[x]].w - shotDim[seq[y]].w) < 1e-9;
      };
      // One greedy sweep: for each screen with a twin beside it, the same-shape swap
      // that removes the most clashes, until a pass finds nothing.
      var tidy = function(){
        for (var pass2=0; pass2<6; pass2++){
          var improved = false;
          for (a=0;a<n;a++){
            if (pinned(a) || !clashes(a, seq[a])) continue;
            var bestC = -1, bestGain = 0;
            for (c=0;c<n;c++){
              if (c === a || pinned(c) || seq[c] === seq[a] || !sameShape(a, c)) continue;
              var sa = seq[a], sc = seq[c];
              var before = clashes(a, sa) + clashes(c, sc);
              seq[a] = sc; seq[c] = sa;
              var after = clashes(a, sc) + clashes(c, sa);
              seq[a] = sa; seq[c] = sc;
              if (before - after > bestGain){ bestGain = before - after; bestC = c; }
            }
            if (bestC >= 0){ var t4 = seq[a]; seq[a] = seq[bestC]; seq[bestC] = t4; improved = true; }
          }
          if (!improved) break;
        }
      };
      // RESTARTS, because one-for-one swaps get stuck: measured on 100 screens, the
      // sweep took 18-31 clashes down to 0-5 and then every remaining swap only moved a
      // clash somewhere else. So while any are left, re-deal the screens within each
      // shape (the layout is unchanged by that) and sweep again, keeping the best
      // arrangement. Seeded from the shuffle's own seed, so "Shuffle again" is still
      // the only thing that changes the result.
      tidy();
      var best = seq.slice(), bestScore = total();
      var groups = {};
      for (a=0;a<n;a++){
        if (pinned(a)) continue;
        var key = shotDim[seq[a]].w.toFixed(6) + '|' + shotDim[seq[a]].d.toFixed(6);
        (groups[key] = groups[key] || []).push(a);
      }
      var rng2 = mulberry32(S.seed * 7349 + n);
      for (var attempt=1; attempt<20 && bestScore > 0; attempt++){
        Object.keys(groups).forEach(function(key){
          var cells = groups[key], vals = cells.map(function(x){ return seq[x]; });
          for (var r=vals.length-1; r>0; r--){ var j = Math.floor(rng2() * (r+1)); var tv = vals[r]; vals[r] = vals[j]; vals[j] = tv; }
          cells.forEach(function(x, k2){ seq[x] = vals[k2]; });
        });
        tidy();
        var score = total();
        if (score < bestScore){ bestScore = score; best = seq.slice(); }
      }
      seq = best;

      // A SCREENSHOT WITH NO OTHER OF ITS SHAPE can only swap with its own copies,
      // which changes nothing — measured: every clash left after the restarts was the
      // one 2220x1480 shot in a set of 3200x1800s and 1600x1800s. So what remains is
      // tried against screens of ANY shape, re-running the layout for each candidate
      // (a different shape reflows everything after it). Kept only if it lowers the
      // clashes and does not move a pinned screen further from the middle. Only ever
      // reached with a few clashes left, so the cost stays small.
      if (bestScore > 0){
        var heroSpread = function(){
          var mp2 = masonryPos(dimsOf(seq)), t6 = 0;
          for (var z=0;z<n;z++) if (pin[z]) t6 += mp2[z].x*mp2[z].x + mp2[z].z*mp2[z].z*1.4;
          return t6;
        };
        nbrs = buildNbrs();
        var current = total(), spread = heroSpread();
        for (var pass3=0; pass3<6 && current > 0; pass3++){
          var moved = false;
          for (a=0;a<n && current > 0;a++){
            if (pinned(a) || !clashes(a, seq[a])) continue;
            for (c=0;c<n;c++){
              if (c === a || pinned(c) || seq[c] === seq[a] || sameShape(a, c)) continue;
              var t7 = seq[a]; seq[a] = seq[c]; seq[c] = t7;
              var keepNbrs = nbrs; nbrs = buildNbrs();
              var next = total(), nextSpread = heroSpread();
              if (next < current && nextSpread <= spread + 1e-9){ current = next; spread = nextSpread; moved = true; break; }
              nbrs = keepNbrs; t7 = seq[a]; seq[a] = seq[c]; seq[c] = t7;
            }
          }
          if (!moved) break;
        }
      }
    }
    var dims = dimsOf(seq);

    // Cell centres. Grid keeps uniform rows; masonry drops each screen into the
    // shallowest column so tall and short screens pack together.
    var pos = [], i;
    if (S.masonry){
      pos = masonryPos(dims);
    } else {
      for (i=0;i<n;i++){
        var gr = Math.floor(i/cols), gc = i % cols;
        var inRow = Math.min(cols, n - gr*cols);
        pos.push({
          x: (gc - (inRow-1)/2) * cellX + (gr % 2 ? S.stagger * cellX * 0.5 : 0),
          z: (gr - (rows-1)/2) * cellZ
        });
      }
    }

    for (i=0;i<n;i++){
      var s = shots[seq[i]];
      if (!s.tex) makeTexture(s);

      var w = dims[i].w;
      var h = dims[i].h;
      var x = pos[i].x;
      var z = pos[i].z;

      // pivot sits on the floor at the screen's front edge, offset so the
      // screen stays centred on its cell whatever the tilt
      var g = new THREE.Group();
      g.position.set(x, 0, z + (h*ct)/2);
      g.rotation.y = spin;

      var mesh = new THREE.Mesh(tileGeo, shotMaterial(s));
      mesh.scale.set(w, h, 1);
      mesh.rotation.x = -Math.PI/2 + tilt;
      mesh.position.y = 0.004 + i*0.0002;
      g.add(mesh);
      itemsGroup.add(g);

      if (S.shadow > 0){
        var d = Math.max(0.08, ct);
        var sm = new THREE.Mesh(shadowGeo, shadowMaterial(
          shadowTexture(w/Math.max(h*d,0.05)),
          S.shadow/100 * (0.55 + 0.45*(1-ct))
        ));
        sm.scale.set(w*1.22, h*d*1.22 + 0.05, 1);
        sm.rotation.x = -Math.PI/2;
        sm.rotation.z = -spin;
        sm.position.set(x, 0.0015, z - 0.02*(1-ct));
        sm.renderOrder = -1;
        shadowGroup.add(sm);
      }
    }
    needsBuild = false;
  }

  /* ───────── camera ───────── */
  var box = new THREE.Box3(), sphere = new THREE.Sphere();
  function placeCamera(){
    camera.fov = S.fov;
    camera.aspect = aspect();
    camera.updateProjectionMatrix();

    var target = new THREE.Vector3(0,0,0), radius = 1;
    if (itemsGroup.children.length){
      box.setFromObject(itemsGroup);
      box.getBoundingSphere(sphere);
      target.copy(sphere.center);
      radius = Math.max(sphere.radius, 0.2);
    }
    var vFov = camera.fov * Math.PI/180;
    var hFov = 2 * Math.atan(Math.tan(vFov/2) * camera.aspect);
    var dist = Math.max(radius/Math.sin(vFov/2), radius/Math.sin(hFov/2)) * 1.05 / S.zoom;

    var yaw = S.yaw * Math.PI/180, pitch = S.pitch * Math.PI/180;
    camera.position.set(
      target.x + dist * Math.cos(pitch) * Math.sin(yaw),
      target.y + dist * Math.sin(pitch),
      target.z + dist * Math.cos(pitch) * Math.cos(yaw)
    );
    camera.lookAt(target);
    // The depth range fits the scene, not 0.01-4000: a 400,000:1 range left the depth
    // buffer too coarse to keep screens standing close together in order. The near
    // plane stays in front of anything the scene could put between camera and target.
    camera.near = Math.max(0.001, (dist - radius * 1.5) * 0.5);
    camera.far = dist + radius * 4 + 10;
    camera.updateProjectionMatrix();

    // The frame as it meets the floor at the board — what a gradient spans (syncFloor).
    frameOnFloor.x = target.x; frameOnFloor.z = target.z;
    frameOnFloor.h = dist * Math.tan(vFov / 2);
    frameOnFloor.w = frameOnFloor.h * camera.aspect;
  }
  var frameOnFloor = { x: 0, z: 0, w: 1, h: 1 };

  /* ───────── render loop ───────── */
  function sizePreview(){
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(2, Math.round(rect.width));
    var h = Math.max(2, Math.round(rect.height));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    needsRender = true;
  }

  function applyClear(){
    if (S.alpha){
      renderer.setClearColor(0x000000, 0);
    } else if (floor.visible){
      // Above the horizon (a standing camera), the sky is the colour the floor runs into
      // as it recedes: the edge colour for radial; for linear, whichever end lies away
      // from the camera, or the midpoint when the gradient runs across the view.
      var c = S.bg2;
      if (S.fill === 'linear'){
        var f = new THREE.Vector3();
        camera.getWorldDirection(f);
        var along = f.x * floorMat.uniforms.uDir.value.x + f.z * floorMat.uniforms.uDir.value.y;
        var flat = Math.hypot(f.x, f.z) || 1;
        var t = Math.max(0, Math.min(1, 0.5 + 0.5 * Math.sign(along) * Math.min(1, Math.abs(along) / flat * 4)));
        c = '#' + new THREE.Color(S.bg).lerp(new THREE.Color(S.bg2), t).getHexString();
      }
      renderer.setClearColor(new THREE.Color(c), 1);
    } else {
      renderer.setClearColor(new THREE.Color(S.bg), 1);
    }
  }

  function frameLoop(){
    if (needsBuild) build();
    if (needsRender){
      syncRadius();
      placeCamera();
      syncFloor();  // after the camera: the gradient spans its frame
      applyClear(); // and the sky colour depends on where it looks
      renderer.render(scene, camera);
      needsRender = false;
      if (settling && !loading){ settling = false; syncLoading(); }
    }
    raf = requestAnimationFrame(frameLoop);
  }

  /* ───────── files ───────── */
  // A SETTINGS FILE (the JSON Export writes) can come in by any route an image can —
  // dropped, pasted or picked — and applies to whatever screenshots are loaded, before
  // or after. It is a LOOK, not a session: camera, arrangement, size, background.
  var emptyText = root.querySelector('.c-showboard__empty-text');
  var EMPTY_TEXT = emptyText.textContent;

  function isSettingsFile(f){
    return f && (f.type === 'application/json' || /\.json$/i.test(f.name || ''));
  }

  // Every value is checked against what its default is before it is taken: the same
  // type, a hex colour for the background, a clamp for the size (applySize). Anything
  // this version does not know is ignored, so a hand-edited or foreign file cannot
  // break it.
  function importSettings(f){
    var reader = new FileReader();
    reader.onload = function(e){
      var data;
      try { data = JSON.parse(e.target.result); } catch (err) { data = null; }
      // 'surface' was this tool's name before it was Showboard; its files still load.
      if (!data || (data.tool !== 'showboard' && data.tool !== 'surface') || typeof data.settings !== 'object' || !data.settings){
        toast('That file is not Showboard settings');
        return;
      }
      Object.keys(DEFAULTS).forEach(function(key){
        var v = data.settings[key];
        if (typeof v !== typeof DEFAULTS[key]) return;
        if (typeof v === 'number' && !isFinite(v)) return;
        if ((key === 'bg' || key === 'bg2') && !/^#[0-9a-f]{6}$/i.test(v)) return;
        if (key === 'fill' && !FILL_LABELS[v]) return;
        S[key] = v;
      });
      syncAll();
      renderShotList(); // Auto columns follow the size
      // The empty stage's invitation changes once there are settings to put images
      // under (Jon, 29 Sep 2026); Reset puts the first one back.
      emptyText.textContent = 'Drop screenshots from a previous session here';
      toast('Settings loaded', 'success');
    };
    reader.readAsText(f);
  }

  function addFiles(list){
    var all = Array.prototype.slice.call(list || []);
    all.filter(isSettingsFile).forEach(importSettings);
    var files = all.filter(function(f){
      return f && f.type && f.type.indexOf('image/') === 0;
    });
    if (!files.length) return;
    // A WHOLE DROP LANDS AT ONCE, in the order it was dropped. Each file used to join
    // the board the moment it decoded, so a big drop rebuilt the layout once per image,
    // in whatever order they finished. Now the batch waits for its last image, with
    // the spinner on the stage meanwhile (Jon, 2 Oct 2026: "it seems to think about
    // it"). A file that can't be read is skipped rather than holding the rest.
    var batch = new Array(files.length);
    var left = files.length;
    loading++;
    syncLoading();
    var done = function(){
      if (--left) return;
      batch.forEach(function(shot){ if (shot) shots.push(shot); });
      loading--;
      settling = true; // the spinner stays until the board has been drawn with them
      renderShotList();
      needsBuild = true; needsRender = true;
    };
    files.forEach(function(f, i){
      var reader = new FileReader();
      reader.onerror = done;
      reader.onload = function(e){
        var img = new Image();
        img.onerror = done;
        img.onload = function(){
          batch[i] = { id: nextId++, name: f.name || 'screenshot', img: img,
                       w: img.naturalWidth, h: img.naturalHeight, tex: null, mat: null };
          done();
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(f);
    });
  }

  // THE SPINNER replaces the stage's invitation while a drop is being read and the
  // board built from it — over the board too, when images are added to one.
  var loading = 0, settling = false;
  function syncLoading(){
    var busy = loading > 0 || settling;
    $('empty').classList.toggle('is-loading', busy);
    $('empty').setAttribute('aria-busy', busy ? 'true' : 'false');
    $('empty').style.display = (busy || !shots.length) ? 'flex' : 'none';
  }

  function renderShotList(){
    var ul = $('shots');
    ul.innerHTML = '';
    shots.forEach(function(s, i){
      // BEM, as the rest of the site (see _showboard.scss): the row is c-showboard__shot,
      // its parts are elements of the block, pinned is a modifier.
      var li = document.createElement('li');
      li.className = 'c-showboard__shot' + (s.hero ? ' c-showboard__shot--pinned' : '');

      var im = document.createElement('img');
      im.className = 'c-showboard__shot-thumb';
      im.src = s.img.src; im.alt = '';
      li.appendChild(im);

      var nm = document.createElement('div');
      nm.className = 'c-showboard__shot-name';
      nm.textContent = s.name;
      var dims = document.createElement('span');
      dims.className = 'c-showboard__shot-meta';
      dims.textContent = s.w + '×' + s.h + (s.hero ? ' · centre' : '');
      nm.appendChild(dims);
      li.appendChild(nm);

      var mini = document.createElement('div');
      mini.className = 'c-showboard__shot-actions';
      var pin = miniBtn(s.hero ? '★' : '☆', 'Keep this one in the middle', true, function(){
        s.hero = !s.hero; renderShotList(); needsBuild = true; needsRender = true;
      });
      pin.classList.add('c-showboard__shot-btn--pin');
      if (s.hero) pin.classList.add('is-on');
      pin.setAttribute('aria-pressed', s.hero ? 'true' : 'false');
      mini.appendChild(pin);
      mini.appendChild(miniBtn('↑','Move earlier', i>0, function(){ swap(i,i-1); }));
      mini.appendChild(miniBtn('↓','Move later', i<shots.length-1, function(){ swap(i,i+1); }));
      var del = miniBtn('✕','Remove', true, function(){
        disposeShot(shots[i]);
        shots.splice(i,1); renderShotList(); needsBuild = true; needsRender = true;
      });
      del.classList.add('c-showboard__shot-btn--remove');
      mini.appendChild(del);
      li.appendChild(mini);

      ul.appendChild(li);
    });
    var total = shots.length * Math.max(1, Math.round(S.repeat));
    $('count').textContent = shots.length ? shots.length + ' loaded' : '';
    syncLoading();
    $('png').disabled = !shots.length;
    // Nothing to arrange, frame or export until there is something loaded: only
    // Screenshots and Size show on an empty tool (Jon, 29 Sep 2026).
    root.querySelectorAll('[data-showboard-needs-shots]').forEach(function(sec){ sec.hidden = !shots.length; });
  }

  function miniBtn(label, title, enabled, fn){
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'c-showboard__shot-btn';
    b.textContent = label; b.title = title; b.disabled = !enabled;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', fn);
    return b;
  }

  function swap(a,b){
    var t = shots[a]; shots[a] = shots[b]; shots[b] = t;
    renderShotList(); needsBuild = true; needsRender = true;
  }

  /* ───────── controls ───────── */
  function fmt(key, v){
    switch(key){
      case 'cols':    return v === 0 ? 'Auto' : v;
      case 'repeat':  return '×' + Math.round(v);
      case 'gap':     return Number(v).toFixed(2);
      case 'depth':   return Number(v).toFixed(2) + '×';
      case 'zoom':    return Number(v).toFixed(2) + '×';
      case 'stagger': return Math.round(v*100) + '%';
      case 'radius':  return Number(v).toFixed(1) + '%';
      case 'angle':   return Math.round(v) + '°';
      case 'spread':  return Math.round(v) + '%';
      case 'shadow':  return Math.round(v) + '%';
      case 'fov':     return Math.round(v) + ' mm';
      default:        return Math.round(v) + '°';
    }
  }

  var sliders = ['cols','repeat','gap','depth','stagger','tilt','spin','radius','shadow','yaw','pitch','fov','zoom','angle','spread'];
  var rebuilders = { cols:1, repeat:1, gap:1, depth:1, stagger:1, tilt:1, spin:1, shadow:1 }; // not radius: a uniform

  sliders.forEach(function(key){
    var el = $(key);
    el.addEventListener('input', function(){
      S[key] = parseFloat(el.value);
      syncOut(key);
      if (rebuilders[key]) { needsBuild = true; if (key === 'cols' || key === 'repeat') renderShotList(); }
      needsRender = true;
    });
  });

  function syncOut(key){
    $(key + '-o').textContent = fmt(key, S[key]);
  }

  /* ───────── size ───────── */
  // THE EXPORT SIZE (Jon, 29 Sep 2026). Its shape is the frame's: the camera, the
  // preview box and Auto columns all follow it, so what you see is what you export.
  // The ceiling is 5000 a side (Jon, 29 Sep 2026), or less where THIS GPU cannot
  // render that much in one go (its renderbuffer/texture limit) — past that an export
  // fails, so the field will not ask for it.
  var SIZE_MIN = 320;
  var SIZE_MAX = Math.min(5000, maxBuffer());
  function aspect(){ return S.outW / S.outH; }

  function clampSize(v, fallback){
    v = Math.round(parseFloat(v));
    if (!isFinite(v)) return fallback;
    return Math.min(SIZE_MAX, Math.max(SIZE_MIN, v));
  }

  function applySize(){
    S.outW = clampSize(S.outW, DEFAULTS.outW);
    S.outH = clampSize(S.outH, DEFAULTS.outH);
    ['outw', 'outh'].forEach(function(id){ $(id).max = SIZE_MAX; $(id).min = SIZE_MIN; });
    $('outw').value = S.outW; $('outh').value = S.outH;
    var label = S.outW + ' × ' + S.outH;
    $('out-meta').textContent = label;
    var frame = $('frame');
    frame.style.setProperty('--sb-aspect', S.outW + ' / ' + S.outH);
    frame.style.setProperty('--sb-ratio', String(aspect()));
    needsBuild = true; needsRender = true;
  }

  ['outw', 'outh'].forEach(function(id){
    var key = id === 'outw' ? 'outW' : 'outH';
    // On `change` (blur or Enter), not every keystroke: clamping "3" to 320 while
    // someone is still typing "3200" would fight them.
    $(id).addEventListener('change', function(){
      S[key] = clampSize(this.value, S[key]);
      applySize();
      renderShotList(); // Auto columns follow the shape
    });
  });

  function syncAll(){
    sliders.forEach(function(k){ $(k).value = S[k]; syncOut(k); });
    applySize();
    $('bg').value = S.bg; $('bg-hex').value = S.bg.toUpperCase();
    $('bg2').value = S.bg2; $('bg2-hex').value = S.bg2.toUpperCase();
    syncFill();
    $('shuffle').checked = S.shuffle;
    $('masonry').checked = S.masonry;
    $('matchw').checked = S.matchw;
    $('reshuffle').disabled = !S.shuffle;
    $('alpha').checked = S.alpha;
    needsBuild = true; needsRender = true;
  }

  function hookColour(colourId, hexId, key){
    var col = $(colourId), hex = $(hexId);
    col.addEventListener('input', function(){
      S[key] = col.value; hex.value = col.value.toUpperCase(); needsRender = true;
    });
    hex.addEventListener('change', function(){
      var v = hex.value.trim();
      if (v[0] !== '#') v = '#' + v;
      if (/^#[0-9a-f]{6}$/i.test(v)){ S[key] = v.toLowerCase(); col.value = S[key]; hex.value = v.toUpperCase(); needsRender = true; }
      else { hex.value = S[key].toUpperCase(); }
    });
  }
  hookColour('bg','bg-hex','bg');
  hookColour('bg2','bg2-hex','bg2');

  // FILL: the chips choose solid / linear / radial; the rows and labels follow. A solid
  // fill's one colour is the Background; a gradient's two are From and To (linear) or
  // Centre and Edge (radial).
  var FILL_LABELS = { solid: ['Background', ''], linear: ['From', 'To'], radial: ['Centre', 'Edge'] };
  function syncFill(){
    Array.prototype.forEach.call(root.querySelectorAll('[data-fill]'), function(b){
      b.setAttribute('aria-pressed', b.getAttribute('data-fill') === S.fill ? 'true' : 'false');
    });
    $('bg-label').textContent = FILL_LABELS[S.fill][0];
    $('bg2-label').textContent = FILL_LABELS[S.fill][1] || 'To';
    $('bg2-row').hidden = S.fill === 'solid';
    $('angle-row').hidden = S.fill !== 'linear';
    $('spread-row').hidden = S.fill !== 'radial';
    needsRender = true;
  }
  Array.prototype.forEach.call(root.querySelectorAll('[data-fill]'), function(b){
    b.addEventListener('click', function(){ S.fill = b.getAttribute('data-fill'); syncFill(); });
  });

  $('masonry').addEventListener('change', function(){
    S.masonry = this.checked; needsBuild = true; needsRender = true;
  });
  $('matchw').addEventListener('change', function(){
    S.matchw = this.checked; needsBuild = true; needsRender = true;
  });

  $('shuffle').addEventListener('change', function(){
    S.shuffle = this.checked;
    $('reshuffle').disabled = !S.shuffle;
    if (S.shuffle) S.seed = Math.floor(Math.random()*100000) + 1;
    needsBuild = true; needsRender = true;
  });
  $('reshuffle').addEventListener('click', function(){
    S.seed = Math.floor(Math.random()*100000) + 1;
    needsBuild = true; needsRender = true;
  });

  $('alpha').addEventListener('change', function(){ S.alpha = this.checked; needsRender = true; });

  var PRESETS = {
    flat:  { yaw:0,   pitch:89, tilt:0,  spin:0,  fov:22, zoom:1.02, gap:0.22, depth:1,    stagger:0 },
    angle: { yaw:-22, pitch:46, tilt:0,  spin:0,  fov:34, zoom:1,    gap:0.30, depth:1.15, stagger:0 },
    stand: { yaw:-14, pitch:18, tilt:90, spin:0,  fov:30, zoom:1,    gap:0.28, depth:1.4,  stagger:0 },
    iso:   { yaw:-35, pitch:35, tilt:26, spin:12, fov:12, zoom:1,    gap:0.34, depth:1.1,  stagger:0.4 }
  };
  Array.prototype.forEach.call(root.querySelectorAll('[data-preset]'), function(b){
    b.addEventListener('click', function(){
      Object.assign(S, PRESETS[b.dataset.preset]);
      syncAll();
    });
  });

  // RESET CLEARS EVERYTHING (Jon, 29 Sep 2026) — every screenshot and every setting,
  // back to a fresh page — and asks first, through the dialog in showboard.twig.
  function resetAll(){
    shots.forEach(disposeShot);
    shots.length = 0;
    Object.assign(S, DEFAULTS);
    emptyText.textContent = EMPTY_TEXT;
    syncAll();
    renderShotList();
    toast('Everything reset', 'success');
  }
  var confirmBox = $('confirm');
  $('reset').addEventListener('click', function(){
    confirmBox.returnValue = '';
    confirmBox.showModal();
  });
  confirmBox.addEventListener('close', function(){
    if (confirmBox.returnValue === 'reset') resetAll();
  });

  /* ───────── stage interaction ───────── */
  // NONE, on purpose (Jon, 29 Sep 2026): no drag-to-orbit and no scroll-to-zoom on the
  // stage. The camera is set by its sliders and presets only, so a stray drag or a
  // scroll over the preview can never move a composition someone has set up.

  /* ───────── drop / paste ───────── */
  var dropZone = $('drop');
  dropZone.addEventListener('click', function(){ $('file').click(); });
  dropZone.addEventListener('keydown', function(e){
    if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); $('file').click(); }
  });
  $('file').addEventListener('change', function(){ addFiles(this.files); this.value = ''; });

  ['dragenter','dragover'].forEach(function(ev){
    on(window, ev, function(e){ e.preventDefault(); dropZone.classList.add('is-hot'); });
  });
  ['dragleave','drop'].forEach(function(ev){
    on(window, ev, function(e){ e.preventDefault(); if (ev==='drop'||e.target===document.documentElement) dropZone.classList.remove('is-hot'); });
  });
  on(window, 'drop', function(e){ e.preventDefault(); addFiles(e.dataTransfer && e.dataTransfer.files); });
  on(window, 'paste', function(e){
    if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length){
      addFiles(e.clipboardData.files);
    }
  });

  /* ───────── export ───────── */

  function maxBuffer(){
    var gl = renderer.getContext();
    try { return Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_TEXTURE_SIZE)); }
    catch(err){ return 4096; }
  }

  // PNG ONLY (Jon, 29 Sep 2026): the JPG option was dropped, so there is one format and
  // Transparent background always means what it says.
  function exportImage(){
    if (!shots.length) return;
    var OUT_W = S.outW, OUT_H = S.outH;
    // ALWAYS 2x, then scaled down, wherever the GPU can hold it (Jon, 29 Sep 2026: the
    // option went — there was no reason to turn it off). Clean edges on anything at an
    // angle, crisper detail inside the screenshots. The LONGER side, doubled, has to
    // fit; where it does not, the export quietly renders at 1x and the toast says so.
    var mult = (maxBuffer() >= Math.max(OUT_W, OUT_H)*2) ? 2 : 1;
    var w = OUT_W * mult, h = OUT_H * mult;

    var prevPR = renderer.getPixelRatio();
    var size = renderer.getSize(new THREE.Vector2());
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    syncRadius();
    placeCamera();
    syncFloor();
    applyClear();
    renderer.render(scene, camera);

    var url;
    if (mult === 1){
      url = canvas.toDataURL('image/png');
    } else {
      var out = document.createElement('canvas');
      out.width = OUT_W; out.height = OUT_H;
      var ctx = out.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(canvas, 0, 0, OUT_W, OUT_H);
      url = out.toDataURL('image/png');
    }

    renderer.setPixelRatio(prevPR);
    renderer.setSize(size.x, size.y, false);
    needsRender = true;

    var name = 'showboard-' + OUT_W + 'x' + OUT_H + '.png';
    var note = OUT_W + ' × ' + OUT_H + (mult===2 ? ' · 2× render' : '');
    savePng(dataUrlToBlob(url), name, note);
  }

  // The PNG as a Blob, made synchronously from the data URL so the click that asked for
  // it still counts as the user's gesture when it reaches the share sheet below.
  function dataUrlToBlob(url){
    var bin = atob(url.slice(url.indexOf(',') + 1));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: 'image/png' });
  }

  // HANDING THE PNG OVER (Jon, 2 Oct 2026: on iPhone, Save PNG showed View / Download and
  // then nothing happened). It was an <a download> pointing at a data: URL, which iOS
  // Safari will not open — "View" navigates to it and is blocked — and does not reliably
  // download either. On a touch device that can share files, Save PNG now opens the
  // share sheet with the image, where Save Image puts it in Photos. Everywhere else it's
  // a download as before, from a Blob URL, kept alive long enough to be fetched.
  function savePng(blob, name, note){
    var file = null;
    try { file = new File([blob], name, { type: 'image/png' }); } catch (err) {}
    var touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (touch && file && navigator.canShare && navigator.canShare({ files: [file] })){
      navigator.share({ files: [file] }).then(function(){
        toast('Shared PNG · ' + note, 'success');
      }, function(err){
        // Closing the sheet is a choice, not a failure; anything else falls back.
        if (err && err.name === 'AbortError') return;
        download(blob, name, note);
      });
      return;
    }
    download(blob, name, note);
  }

  function download(blob, name, note){
    var href = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function(){ URL.revokeObjectURL(href); }, 60000);
    toast('Saved PNG · ' + note, 'success');
  }

  $('png').addEventListener('click', function(){ exportImage(); });

  // EXPORT SETTINGS (Jon, 29 Sep 2026): the look, not the pictures — every control's
  // value and the output size, so the same angle, arrangement and background can be
  // brought back another day onto different screenshots. No screenshot names, order
  // or pins: those describe one set of images, and the next set will be another.
  // (Format 2; format 1 also listed the screenshots, and still loads — the list is
  // simply not read.)
  function exportSettings(){
    var data = {
      tool: 'showboard',
      format: 2,
      exportedAt: new Date().toISOString(),
      settings: Object.assign({}, S)
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'showboard-settings-' + S.outW + 'x' + S.outH + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
    toast('Saved settings · JSON', 'success');
  }
  $('settings').addEventListener('click', exportSettings);

  var toastTimer;
  // `kind` 'success' adds the green tick (.c-tool__toast--success).
  function toast(msg, kind){
    var t = $('toast');
    t.textContent = msg;
    t.classList.toggle('c-tool__toast--success', kind === 'success');
    t.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ t.classList.remove('is-visible'); }, 2400);
  }

  /* ───────── go ───────── */
  on(window, 'resize', sizePreview);
  var ro = window.ResizeObserver ? new ResizeObserver(sizePreview) : null;
  if (ro) ro.observe($('frame'));
  syncAll();
  renderShotList();
  sizePreview();
  frameLoop();

  return function dispose(){
    cancelAnimationFrame(raf);
    listeners.forEach(function(l){ l[0].removeEventListener(l[1], l[2], l[3]); });
    if (ro) ro.disconnect();
    shots.forEach(disposeShot);
    clearShadowMats();
    tileGeo.dispose();
    shadowGeo.dispose();
    renderer.dispose();
  };
}
