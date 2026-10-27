import * as THREE from 'three';
import { toPlane } from './proj.js';

export class LabelManager {
  constructor(container, meta) {
    this.container = container;
    this.meta = meta;
    this.labels = [];
    this.elements = [];
    this.visible = true;
    this.lang = 'ja';
    // Wave-source label: next to the place labels but shown even when they are switched off
    this.source = null;
    this.sourceEl = document.createElement('div');
    this.sourceEl.className = 'map-3d-label wave-source-label';
    this.sourceEl.style.display = 'none';
    container.parentElement.appendChild(this.sourceEl);
  }

  /** Wave-source label at scene position pos (THREE.Vector3); null hides it. */
  setSource(pos, text = '') {
    this.source = pos;
    this.sourceEl.innerHTML = `<span class="label-dot"></span><span class="label-text"></span>`;
    this.sourceEl.querySelector('.label-text').textContent = text;
    if (!pos) this.sourceEl.style.display = 'none';
  }

  async loadLabels() {
    try {
      const res = await fetch('data/labels.json');
      if (!res.ok) return;
      this.labels = await res.json();
      this.createElements();
    } catch (e) {
      console.warn('Failed to load labels:', e);
    }
  }

  createElements() {
    this.container.innerHTML = '';
    this.elements = [];

    const { originE, originN, res, nx, ny } = this.meta;
    const W = nx * res;
    const H = ny * res;

    for (const l of this.labels) {
      const [e, n] = toPlane(l.lon, l.lat);
      const x = e - originE - W / 2;
      const z = originN - n - H / 2;
      const y = (l.height || 20) + 20;

      const el = document.createElement('div');
      el.className = 'map-3d-label';
      el.innerHTML = `<span class="label-dot"></span><span class="label-text">${this.lang === 'en' ? l.name_en : l.name}</span>`;
      this.container.appendChild(el);

      this.elements.push({
        el,
        label: l,
        pos: new THREE.Vector3(x, y, z),
      });
    }
  }

  update(camera, width, height) {
    if (this.source) this.place(this.sourceEl, this.source, camera, width, height);
    if (!this.visible) {
      this.container.style.display = 'none';
      return;
    }
    this.container.style.display = 'block';

    const tempV = new THREE.Vector3();
    const camDir = camera.getWorldDirection(new THREE.Vector3());

    for (const item of this.elements) {
      tempV.copy(item.pos);

      const toLabel = tempV.clone().sub(camera.position);
      if (toLabel.dot(camDir) < 0) {
        item.el.style.display = 'none';
        continue;
      }

      tempV.project(camera);
      const x = (tempV.x * 0.5 + 0.5) * width;
      const y = (-(tempV.y * 0.5) + 0.5) * height;

      if (tempV.z > 1.0 || x < -50 || x > width + 50 || y < -50 || y > height + 50) {
        item.el.style.display = 'none';
      } else {
        item.el.style.display = 'flex';
        item.el.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
      }
    }
  }

  place(el, pos, camera, width, height) {
    const v = pos.clone();
    if (v.clone().sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3())) < 0) {
      el.style.display = 'none';
      return;
    }
    v.project(camera);
    const x = (v.x * 0.5 + 0.5) * width;
    const y = (-(v.y * 0.5) + 0.5) * height;
    if (v.z > 1.0 || x < -50 || x > width + 50 || y < -50 || y > height + 50) {
      el.style.display = 'none';
    } else {
      el.style.display = 'flex';
      el.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
    }
  }

  setVisible(v) {
    this.visible = v;
    this.container.style.display = v ? 'block' : 'none';
  }

  setLanguage(lang) {
    this.lang = lang;
    for (const item of this.elements) {
      const span = item.el.querySelector('.label-text');
      if (span) {
        span.textContent = lang === 'en' ? item.label.name_en : item.label.name;
      }
    }
  }
}
