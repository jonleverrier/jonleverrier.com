// The hero's still, for a browser with no GPU: the settled portrait, drawn once into
// a canvas the page has handed over — see createStill() in hero.js for why this runs
// in a worker at all.
//
// Messages in:  {type: 'init', canvas, buf, dpr}  — the OffscreenCanvas and the binary
//               {type: 'size', width, height}     — CSS px, sent on mount and on resize
// Messages out: 'drawn' after each frame, 'failed' if it cannot draw at all.
//
// No loop, intro, sweep or pointer: the uniforms are left at the resting values the
// material is built with, and the camera sits at BASE.

import * as THREE from 'three';
import {BASE, CLEAR_COLOUR, buildCloud, createCamera, frameCloud, placeCamera} from './hero-cloud.js';

let renderer = null;
let camera = null;
let cloud = null;
let size = null;
let queued = false;
const frame = {target: new THREE.Vector3(), R: 0};

function draw() {
  queued = false;
  if (!renderer || !size) return;
  try {
    const {width, height} = size;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    cloud.mat.uniforms.uScale.value = height * 0.5;
    frameCloud(camera, cloud, BASE, frame);
    placeCamera(camera, frame.target, frame.R, BASE);
    renderer.render(cloud.scene, camera);
    postMessage('drawn');
  } catch {
    postMessage('failed');
  }
}

onmessage = ({data}) => {
  if (data.type === 'init') {
    try {
      cloud = buildCloud(data.buf, 1); // uScale is set from the real height in draw()
      renderer = new THREE.WebGLRenderer({canvas: data.canvas, antialias: true, alpha: false});
      renderer.setPixelRatio(data.dpr);
      const applyClearColor = () => renderer.setClearColor(new THREE.Color(CLEAR_COLOUR), 1);
      applyClearColor();
      // Same reason as the animated hero: three rebuilds its state on restore with a
      // black clear colour. A still also has no next frame to repaint it, so it redraws.
      data.canvas.addEventListener('webglcontextrestored', () => { applyClearColor(); draw(); });
      camera = createCamera();
    } catch {
      postMessage('failed');
      return;
    }
  } else if (data.type === 'size') {
    size = data;
  }
  // Coalesced: a window being dragged sends a size per frame, and only the last one
  // needs drawing.
  if (!queued) { queued = true; setTimeout(draw, 0); }
};
