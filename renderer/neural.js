/*
 * Echo's neural core — a 3D spiral galaxy.
 *
 * Real 3D: every star lives in galaxy space (x,y,z), the disk spins with
 * differential rotation, and a camera slowly orbits it — points are rotated in
 * 3D then PERSPECTIVE-projected (near stars larger/brighter, far ones small and
 * dim), depth-sorted so it composites correctly. Canvas 2D, so it's smooth and
 * never trips the GPU compositor. Cyan "data" clusters ride the arms to keep the
 * neural-schema identity.
 */
(() => {
  const cv = document.getElementById("core");
  const ctx = cv.getContext("2d");
  let W, H, CX, CY, FOC, DPR;

  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = W * DPR; cv.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    CX = W / 2; CY = H / 2; FOC = Math.min(W, H) * 0.62; // focal length
  }
  window.addEventListener("resize", resize); resize();

  const CAMD = 2.7;          // camera distance (galaxy units)
  const PITCH = 1.02;        // fixed tilt so we see the disk at an angle
  const NARMS = 2, WIND = 4.6;

  // ---- build the star disk in 3D ----
  const N = 4000, stars = [];
  for (let i = 0; i < N; i++) {
    const r = Math.pow(Math.random(), 0.62);
    const arm = i % NARMS;
    const fray = (Math.random() - 0.5) * (0.32 + r * 1.0);
    const phi0 = arm * (Math.PI * 2 / NARMS) + WIND * r + fray;
    const thick = (Math.random() - 0.5) * 0.07 * (1 - r * 0.4);
    const cr = Math.round(255 - 120 * r), cg = Math.min(255, Math.round(206 + 20 * r)), cb = Math.min(255, Math.round(150 + 105 * r));
    stars.push({ r, phi0, thick, col: `rgb(${cr},${cg},${cb})`,
      size: r < 0.12 ? 2.1 : (Math.random() < 0.08 ? 1.9 : 1.3),
      base: 0.5 + 0.5 * (1 - r), tw: Math.random() * 6.28 });
  }
  document.getElementById("nodes").textContent = N.toLocaleString();
  document.getElementById("syn").textContent = (N * 6).toLocaleString();
  const omega = (r) => 0.16 / (0.14 + r);

  // ---- data clusters riding the arms ----
  const clusters = [];
  for (let k = 0; k < 6; k++) {
    const r = 0.35 + k * 0.1, nodes = [];
    const n = 4 + Math.floor(Math.random() * 4);
    for (let j = 0; j < n; j++) nodes.push({ dphi: (Math.random() - 0.5) * 0.16, dr: (Math.random() - 0.5) * 0.05, dt: (Math.random() - 0.5) * 0.05 });
    clusters.push({ r, phi0: Math.random() * 6.28, nodes });
  }

  // rotate + perspective-project a galaxy-space point. Returns null if behind camera.
  let yaw = 0, cy_ = 1, sy_ = 0, cp = Math.cos(PITCH), sp = Math.sin(PITCH);
  function project(x, y, z) {
    // yaw about Y (camera orbit)
    let rx = x * cy_ + z * sy_, rz = -x * sy_ + z * cy_, ry = y;
    // pitch about X (fixed tilt)
    const py = ry * cp - rz * sp, pz = ry * sp + rz * cp;
    const depth = CAMD - pz;
    if (depth < 0.15) return null;
    const sc = FOC / depth;
    return { x: CX + rx * sc, y: CY + py * sc, z: pz, sc };
  }

  function glow(px, py, rad, inner, outer) {
    const g = ctx.createRadialGradient(px, py, 0, px, py, rad);
    g.addColorStop(0, inner); g.addColorStop(1, outer);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, rad, 0, 7); ctx.fill();
  }

  let start = performance.now();
  function frame(now) {
    const t = (now - start) / 1000;
    yaw = t * 0.06; cy_ = Math.cos(yaw); sy_ = Math.sin(yaw);
    ctx.fillStyle = "#03050a"; ctx.fillRect(0, 0, W, H);

    // background stars
    for (let i = 0; i < 70; i++) {
      const a = Math.sin(i * 12.9898) * 43758.5, b = Math.sin(i * 78.233) * 43758.5;
      ctx.globalAlpha = 0.07 + 0.1 * Math.abs(Math.sin(t * 0.5 + i));
      ctx.fillStyle = "#aecadb"; ctx.fillRect(((a % 1 + 1) % 1) * W, ((b % 1 + 1) % 1) * H, 1, 1);
    }
    ctx.globalAlpha = 1;

    // galactic halo behind everything
    const centre = project(0, 0, 0);
    if (centre) glow(centre.x, centre.y, FOC * 0.5, "rgba(255,225,175,0.28)", "rgba(255,180,110,0)");

    // project all stars, depth-sort (far -> near) for correct compositing
    const drawn = [];
    for (const s of stars) {
      const phi = s.phi0 + t * omega(s.r);
      const p = project(s.r * Math.cos(phi), s.thick, s.r * Math.sin(phi));
      if (p) drawn.push({ p, s });
    }
    drawn.sort((a, b) => b.p.z - a.p.z);
    const nsc = FOC / CAMD; // reference scale
    for (const d of drawn) {
      const depthF = Math.min(1.4, d.p.sc / nsc);
      const tw = 0.7 + 0.3 * Math.sin(t * 2 + d.s.tw);
      ctx.globalAlpha = Math.min(1, d.s.base * tw * depthF * 0.9);
      ctx.fillStyle = d.s.col;
      const sz = d.s.size * depthF;
      ctx.fillRect(d.p.x, d.p.y, sz, sz);
    }
    ctx.globalAlpha = 1;

    // bright galactic core on top
    if (centre) {
      glow(centre.x, centre.y, FOC * 0.14, "#ffffff", "rgba(255,190,120,0)");
      glow(centre.x, centre.y, FOC * 0.07, "#ffffff", "rgba(255,240,200,0)");
    }

    // data clusters
    for (const c of clusters) {
      const cphi = c.phi0 + t * omega(c.r);
      const pts = c.nodes.map((nd) => project((c.r + nd.dr) * Math.cos(cphi + nd.dphi), nd.dt, (c.r + nd.dr) * Math.sin(cphi + nd.dphi))).filter(Boolean);
      ctx.globalAlpha = 0.3; ctx.strokeStyle = "#4fd6ee"; ctx.lineWidth = 1;
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
        if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < FOC * 0.1) {
          ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y); ctx.stroke();
        }
      }
      for (const p of pts) {
        ctx.globalAlpha = 1; glow(p.x, p.y, 5 * (p.sc / nsc), "#eafcff", "rgba(89,240,255,0)");
        ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(p.x, p.y, 1.2, 0, 7); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    document.getElementById("temp").textContent = (2.3 + Math.sin(t) * 0.02).toFixed(2) + "e11 M☉";
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  const closeBtn = document.getElementById("close");
  if (closeBtn) closeBtn.onclick = () => window.echoNeural && window.echoNeural.close();
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") window.echoNeural && window.echoNeural.close(); });
})();
