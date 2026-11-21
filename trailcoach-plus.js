/* ======================================================================
   Trail Coach + : import d'activités (FIT / GPX / TCX / Strava),
   analyse de charge (forme, fatigue, fraîcheur) et moteur du coach IA.

   Fichier JavaScript simple (sans JSX) chargé avant l'application : il
   expose tout sur window.TCP. Les clés (Strava, Anthropic) restent dans le
   localStorage de l'appareil et ne partent jamais dans Firebase.
   ====================================================================== */
(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Utilitaires
  // ---------------------------------------------------------------------
  function toISO(d) {
    const x = new Date(d);
    return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
  }
  function addDaysISO(iso, n) {
    const d = new Date(iso + "T12:00:00");
    d.setDate(d.getDate() + n);
    return toISO(d);
  }
  function mondayISO(d) {
    const x = new Date(typeof d === "string" ? d + "T12:00:00" : d);
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return toISO(x);
  }
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  /** Dénivelé positif avec hystérésis : filtre le bruit d'altitude. */
  function elevationGain(eles, threshold) {
    threshold = threshold || 3;
    let gain = 0, ref = null;
    for (const e of eles) {
      if (e == null || !isFinite(e)) continue;
      if (ref == null) { ref = e; continue; }
      if (e - ref >= threshold) { gain += e - ref; ref = e; }
      else if (ref - e >= threshold) ref = e;
    }
    return Math.round(gain);
  }
  const round1 = x => Math.round(x * 10) / 10;
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  /** Type de séance Trail Coach deviné à partir d'une activité réalisée. */
  function guessType(sport, a) {
    const s = String(sport || "").toLowerCase();
    if (/ride|bike|cycl|vélo|velo|biking/.test(s)) return "velo";
    if (/swim|natation/.test(s)) return "natation";
    if (/weight|strength|training|workout|crossfit|yoga|renfo|fitness_equipment/.test(s)) return "renfo";
    if (s && !/run|trail|course|running|walk|hike|randon/.test(s)) return "autre";
    const duree = a.duree || 0, km = a.distance || 0;
    if (duree >= 100 || km >= 18) return "longue";
    if (a.laps && a.laps.length >= 6) {
      // beaucoup de tours courts : probablement du fractionné ou des côtes
      const short = a.laps.filter(l => l.sec < 360).length;
      if (short >= 4) return km && a.dplus / km > 40 ? "cotes" : "fractionne";
    }
    if (duree && duree <= 40 && (a.feeling || 3) <= 2) return "recup";
    return "fonda";
  }

  // ---------------------------------------------------------------------
  // Décodeur FIT minimal (record, lap, session)
  // ---------------------------------------------------------------------
  const FIT_EPOCH = Date.UTC(1989, 11, 31);
  const BASE_SIZE = { 0: 1, 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 1, 8: 4, 9: 8, 10: 1, 11: 2, 12: 4, 13: 1, 14: 8, 15: 8, 16: 8 };
  const INVALID = { 0: 0xFF, 1: 0x7F, 2: 0xFF, 3: 0x7FFF, 4: 0xFFFF, 5: 0x7FFFFFFF, 6: 0xFFFFFFFF, 10: 0, 11: 0, 12: 0 };

  function readValue(view, off, base, size, little) {
    const t = base & 0x1F;
    if (size !== BASE_SIZE[t]) return null; // tableaux et chaînes ignorés
    let v;
    switch (t) {
      case 0: case 2: case 10: case 13: v = view.getUint8(off); break;
      case 1: v = view.getInt8(off); break;
      case 3: v = view.getInt16(off, little); break;
      case 4: case 11: v = view.getUint16(off, little); break;
      case 5: v = view.getInt32(off, little); break;
      case 6: case 12: v = view.getUint32(off, little); break;
      case 8: v = view.getFloat32(off, little); return isFinite(v) ? v : null;
      case 9: v = view.getFloat64(off, little); return isFinite(v) ? v : null;
      default: return null;
    }
    if (INVALID[t] !== undefined && v === INVALID[t]) return null;
    return v;
  }

  function decodeFit(buffer) {
    const view = new DataView(buffer);
    const headerSize = view.getUint8(0);
    const dataSize = view.getUint32(4, true);
    const sig = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    if (sig !== ".FIT") throw new Error("Ce fichier n'est pas un fichier FIT valide.");
    const end = Math.min(buffer.byteLength, headerSize + dataSize);
    const defs = {};
    const out = { records: [], laps: [], sessions: [], sport: null };
    let off = headerSize, lastTs = 0;

    while (off < end) {
      const h = view.getUint8(off++);
      let local, compressedTs = null;
      if (h & 0x80) { // en-tête à horodatage compressé
        local = (h >> 5) & 0x03;
        const offset = h & 0x1F;
        let ts = (lastTs & 0xFFFFFFE0) + offset;
        if (offset < (lastTs & 0x1F)) ts += 0x20;
        compressedTs = ts; lastTs = ts;
      } else if (h & 0x40) { // message de définition
        local = h & 0x0F;
        const hasDev = !!(h & 0x20);
        off++; // réservé
        const little = view.getUint8(off++) === 0;
        const global = view.getUint16(off, little); off += 2;
        const n = view.getUint8(off++);
        const fields = [];
        for (let i = 0; i < n; i++) {
          fields.push({ num: view.getUint8(off), size: view.getUint8(off + 1), base: view.getUint8(off + 2) });
          off += 3;
        }
        let devSize = 0;
        if (hasDev) {
          const nd = view.getUint8(off++);
          for (let i = 0; i < nd; i++) { devSize += view.getUint8(off + 1); off += 3; }
        }
        defs[local] = { global, little, fields, devSize };
        continue;
      } else {
        local = h & 0x0F;
      }
      const def = defs[local];
      if (!def) throw new Error("Fichier FIT corrompu (définition manquante).");
      const msg = {};
      for (const f of def.fields) {
        const v = readValue(view, off, f.base, f.size, def.little);
        if (v !== null) msg[f.num] = v;
        off += f.size;
      }
      off += def.devSize;
      if (msg[253] != null) lastTs = msg[253];
      if (compressedTs != null && msg[253] == null) msg[253] = compressedTs;

      const ts = msg[253] != null ? FIT_EPOCH + msg[253] * 1000 : null;
      if (def.global === 20) { // record
        const alt = msg[78] != null ? msg[78] / 5 - 500 : msg[2] != null ? msg[2] / 5 - 500 : null;
        out.records.push({
          t: ts,
          lat: msg[0] != null ? msg[0] * (180 / 2147483648) : null,
          lon: msg[1] != null ? msg[1] * (180 / 2147483648) : null,
          ele: alt,
          hr: msg[3] != null ? msg[3] : null,
          cad: msg[4] != null ? msg[4] : null,
          dist: msg[5] != null ? msg[5] / 100 : null,
        });
      } else if (def.global === 19) { // lap
        out.laps.push({
          start: msg[2] != null ? FIT_EPOCH + msg[2] * 1000 : ts,
          elapsed: msg[7] != null ? msg[7] / 1000 : null,
          timer: msg[8] != null ? msg[8] / 1000 : null,
          dist: msg[9] != null ? msg[9] / 100 : null,
          hr: msg[15] != null ? msg[15] : null,
          hrMax: msg[16] != null ? msg[16] : null,
          ascent: msg[21] != null ? msg[21] : null,
        });
      } else if (def.global === 18) { // session
        out.sessions.push({
          start: msg[2] != null ? FIT_EPOCH + msg[2] * 1000 : ts,
          sport: msg[5], subSport: msg[6],
          elapsed: msg[7] != null ? msg[7] / 1000 : null,
          timer: msg[8] != null ? msg[8] / 1000 : null,
          dist: msg[9] != null ? msg[9] / 100 : null,
          hr: msg[16] != null ? msg[16] : null,
          hrMax: msg[17] != null ? msg[17] : null,
          cad: msg[18] != null ? msg[18] : null,
          ascent: msg[22] != null ? msg[22] : null,
        });
      } else if (def.global === 12 && msg[0] != null && out.sport == null) { // sport
        out.sport = msg[0];
      }
    }
    return out;
  }

  // Codes de sport FIT les plus courants
  const FIT_SPORT = { 0: "generic", 1: "running", 2: "cycling", 4: "fitness_equipment", 5: "swimming", 10: "training", 11: "walking", 17: "hiking" };
  const FIT_SUBSPORT_TRAIL = 3;

  // ---------------------------------------------------------------------
  // Construction d'une « séance réalisée » Trail Coach
  // ---------------------------------------------------------------------
  /**
   * points : [{t (ms), lat, lon, ele, hr, cad, dist (m cumulés)}]
   * laps   : [{sec, m, fc}] (optionnel)
   * summary: valeurs officielles de la montre si disponibles (prioritaires)
   */
  function buildActivity(points, laps, summary, meta) {
    points = points.filter(p => p.t != null && isFinite(p.t)).sort((a, b) => a.t - b.t);
    summary = summary || {};
    if (points.length < 2 && !summary.dist) throw new Error("Aucune donnée exploitable dans ce fichier.");
    let dist = 0, moving = 0;
    const hasDist = points.filter(p => p.dist != null).length > points.length * 0.5;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      let d = 0;
      if (hasDist && a.dist != null && b.dist != null) d = Math.max(0, b.dist - a.dist);
      else if (a.lat != null && b.lat != null) d = haversine(a.lat, a.lon, b.lat, b.lon);
      const dt = (b.t - a.t) / 1000;
      dist += d;
      if (dt > 0 && dt < 30 && d / dt > 0.6) moving += dt;
      if (!hasDist) b._cum = dist;
    }
    const start = summary.start || (points[0] && points[0].t);
    const elapsed = summary.elapsed || (points.length ? (points[points.length - 1].t - points[0].t) / 1000 : 0);
    const hrs = points.map(p => p.hr).filter(h => h && h > 30);
    const cads = points.map(p => p.cad).filter(c => c && c > 20);

    // Tours : ceux de la montre, sinon un tour par kilomètre
    let outLaps = laps && laps.length ? laps : [];
    if (!outLaps.length && points.length > 10) {
      let km = 1, i0 = 0;
      const cum = p => (hasDist ? p.dist : p._cum) || 0;
      for (let i = 1; i < points.length; i++) {
        if (cum(points[i]) >= km * 1000) {
          const seg = points.slice(i0, i + 1).map(p => p.hr).filter(Boolean);
          outLaps.push({ sec: Math.round((points[i].t - points[i0].t) / 1000), m: Math.round(cum(points[i]) - cum(points[i0])), fc: seg.length ? Math.round(avg(seg)) : null });
          i0 = i; km++;
        }
      }
    }

    const distanceKm = round1((summary.dist != null ? summary.dist : dist) / 1000);
    const dureeMin = Math.round((summary.timer || moving || elapsed) / 60);
    const actual = {
      distance: distanceKm || null,
      dplus: summary.ascent != null ? Math.round(summary.ascent) : (points.some(p => p.ele != null) ? elevationGain(points.map(p => p.ele)) : null),
      duree: dureeMin || null,
      fc: summary.hr || (hrs.length ? Math.round(avg(hrs)) : null),
      fcMax: summary.hrMax || (hrs.length ? Math.max.apply(null, hrs) : null),
      cadence: summary.cad || (cads.length ? Math.round(avg(cads)) : null),
      laps: outLaps.filter(l => l.sec > 0).slice(0, 200),
    };
    const sport = meta.sport || "running";
    return {
      date: toISO(start),
      startTime: start,
      name: meta.name || "",
      sport,
      source: meta.source,
      externalId: meta.externalId || (meta.source + ":" + start),
      actual,
      type: guessType(sport, actual),
    };
  }

  function parseFitFile(buffer, name) {
    const fit = decodeFit(buffer);
    const s = fit.sessions[0] || {};
    const laps = fit.laps.map(l => ({ sec: Math.round(l.timer || l.elapsed || 0), m: Math.round(l.dist || 0), fc: l.hr || null }));
    let sport = FIT_SPORT[s.sport != null ? s.sport : fit.sport] || "running";
    if (sport === "running" && s.subSport === FIT_SUBSPORT_TRAIL) sport = "trail_running";
    return buildActivity(
      fit.records,
      laps.length > 1 ? laps : [],
      { start: s.start, elapsed: s.elapsed, timer: s.timer, dist: s.dist, hr: s.hr, hrMax: s.hrMax, cad: s.cad, ascent: s.ascent },
      { source: "fit", sport, name }
    );
  }

  function byTag(el, name) { return Array.from(el.getElementsByTagNameNS("*", name)); }
  function numOf(el) { if (!el || !el.textContent) return null; const n = parseFloat(el.textContent); return isFinite(n) ? n : null; }

  function parseGpxText(xml) {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("Fichier GPX illisible.");
    const pts = byTag(doc, "trkpt").map(el => ({
      t: Date.parse((byTag(el, "time")[0] || {}).textContent || ""),
      lat: parseFloat(el.getAttribute("lat")), lon: parseFloat(el.getAttribute("lon")),
      ele: numOf(byTag(el, "ele")[0]), hr: numOf(byTag(el, "hr")[0]), cad: numOf(byTag(el, "cad")[0]),
    }));
    const trk = byTag(doc, "trk")[0];
    const name = trk && byTag(trk, "name")[0] ? byTag(trk, "name")[0].textContent : "";
    const type = (byTag(doc, "type")[0] || {}).textContent || "running";
    return buildActivity(pts, [], {}, { source: "gpx", sport: type, name });
  }

  function parseTcxText(xml) {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("Fichier TCX illisible.");
    const pts = byTag(doc, "Trackpoint").map(el => {
      const pos = byTag(el, "Position")[0];
      const hr = byTag(el, "HeartRateBpm")[0];
      return {
        t: Date.parse((byTag(el, "Time")[0] || {}).textContent || ""),
        lat: pos ? numOf(byTag(pos, "LatitudeDegrees")[0]) : null,
        lon: pos ? numOf(byTag(pos, "LongitudeDegrees")[0]) : null,
        ele: numOf(byTag(el, "AltitudeMeters")[0]),
        dist: numOf(byTag(el, "DistanceMeters")[0]),
        hr: hr ? numOf(byTag(hr, "Value")[0]) : null,
        cad: numOf(byTag(el, "RunCadence")[0]) || numOf(byTag(el, "Cadence")[0]),
      };
    });
    const lapEls = byTag(doc, "Lap");
    const laps = lapEls.map(l => {
      const hr = byTag(l, "AverageHeartRateBpm")[0];
      return { sec: Math.round(numOf(byTag(l, "TotalTimeSeconds")[0]) || 0), m: Math.round(numOf(Array.from(l.children).find(c => c.localName === "DistanceMeters")) || 0), fc: hr ? numOf(byTag(hr, "Value")[0]) : null };
    });
    const act = byTag(doc, "Activity")[0];
    const sport = act ? act.getAttribute("Sport") : "Running";
    return buildActivity(pts, laps.length > 1 ? laps : [], {}, { source: "tcx", sport });
  }

  async function parseActivityFile(file) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    let a;
    if (ext === "fit") a = parseFitFile(await file.arrayBuffer(), file.name.replace(/\.fit$/i, ""));
    else if (ext === "gpx") a = parseGpxText(await file.text());
    else if (ext === "tcx") a = parseTcxText(await file.text());
    else throw new Error("Format non pris en charge (." + ext + ") : FIT, GPX ou TCX attendu.");
    a.fileName = file.name;
    return a;
  }

  // ---------------------------------------------------------------------
  // Réglages locaux (jamais synchronisés : contiennent des secrets)
  // ---------------------------------------------------------------------
  const LS = "trailcoach:plus";
  function getLocal() {
    try { return JSON.parse(localStorage.getItem(LS) || "{}"); } catch (e) { return {}; }
  }
  function setLocal(patch) {
    const next = Object.assign(getLocal(), patch);
    localStorage.setItem(LS, JSON.stringify(next));
    return next;
  }

  // ---------------------------------------------------------------------
  // Strava (OAuth côté navigateur, avec ton application Strava personnelle)
  // ---------------------------------------------------------------------
  function stravaRedirectUri() { return location.origin + location.pathname; }

  function stravaAuthorizeUrl() {
    const cfg = getLocal().strava || {};
    if (!cfg.clientId) throw new Error("Renseigne d'abord le Client ID de ton application Strava.");
    const p = new URLSearchParams({
      client_id: cfg.clientId, response_type: "code", redirect_uri: stravaRedirectUri(),
      approval_prompt: "auto", scope: "read,activity:read_all", state: "trailcoach",
    });
    return "https://www.strava.com/oauth/authorize?" + p.toString();
  }

  async function stravaTokenRequest(params) {
    const cfg = getLocal().strava || {};
    const body = new URLSearchParams(Object.assign({ client_id: cfg.clientId, client_secret: cfg.clientSecret }, params));
    const r = await fetch("https://www.strava.com/oauth/token", { method: "POST", body });
    if (!r.ok) throw new Error("Strava a refusé la connexion (" + r.status + "). Vérifie le Client ID / Secret.");
    const tok = await r.json();
    const strava = Object.assign({}, cfg, {
      accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: tok.expires_at,
      athlete: tok.athlete ? [tok.athlete.firstname, tok.athlete.lastname].filter(Boolean).join(" ") : cfg.athlete,
    });
    setLocal({ strava });
    return strava;
  }

  /** À appeler au démarrage : termine la connexion si Strava nous renvoie un code. */
  async function stravaHandleRedirect() {
    const q = new URLSearchParams(location.search);
    if (q.get("state") !== "trailcoach") return null;
    const code = q.get("code"), err = q.get("error");
    history.replaceState(null, "", location.pathname + location.hash);
    if (err) throw new Error("Connexion Strava annulée.");
    if (!code) return null;
    return stravaTokenRequest({ code, grant_type: "authorization_code" });
  }

  async function stravaToken() {
    let cfg = getLocal().strava || {};
    if (!cfg.refreshToken) throw new Error("Strava n'est pas connecté.");
    if (!cfg.accessToken || (cfg.expiresAt || 0) * 1000 < Date.now() + 60000) {
      cfg = await stravaTokenRequest({ refresh_token: cfg.refreshToken, grant_type: "refresh_token" });
    }
    return cfg.accessToken;
  }

  async function stravaGet(path, params) {
    const token = await stravaToken();
    const url = "https://www.strava.com/api/v3" + path + (params ? "?" + new URLSearchParams(params) : "");
    const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    if (r.status === 429) throw new Error("Limite d'appels Strava atteinte : réessaie dans 15 minutes.");
    if (!r.ok) throw new Error("Erreur Strava " + r.status);
    return r.json();
  }

  function stravaToActivity(a, laps) {
    const actual = {
      distance: round1((a.distance || 0) / 1000) || null,
      dplus: a.total_elevation_gain != null ? Math.round(a.total_elevation_gain) : null,
      duree: Math.round((a.moving_time || a.elapsed_time || 0) / 60) || null,
      fc: a.average_heartrate ? Math.round(a.average_heartrate) : null,
      fcMax: a.max_heartrate ? Math.round(a.max_heartrate) : null,
      cadence: a.average_cadence ? Math.round(a.average_cadence) : null,
      laps: (laps || []).map(l => ({ sec: l.moving_time || l.elapsed_time, m: Math.round(l.distance || 0), fc: l.average_heartrate ? Math.round(l.average_heartrate) : null })).filter(l => l.sec > 0),
    };
    if (actual.laps.length < 2) actual.laps = [];
    const sport = a.sport_type || a.type || "Run";
    return {
      date: (a.start_date_local || a.start_date || "").slice(0, 10),
      startTime: Date.parse(a.start_date),
      name: a.name || "",
      sport,
      source: "strava",
      externalId: "strava:" + a.id,
      stravaId: a.id,
      actual,
      type: guessType(sport, actual),
    };
  }

  /** Activités récentes (résumés), sans les tours. */
  async function stravaRecent(days, perPage) {
    const after = Math.floor((Date.now() - (days || 30) * 86400000) / 1000);
    const list = await stravaGet("/athlete/activities", { after, per_page: perPage || 100, page: 1 });
    return list.map(a => stravaToActivity(a));
  }

  /** Activité complète avec ses tours (pour l'analyse par intervalle). */
  async function stravaWithLaps(id) {
    const [a, laps] = await Promise.all([stravaGet("/activities/" + id), stravaGet("/activities/" + id + "/laps")]);
    return stravaToActivity(a, laps);
  }

  // ---------------------------------------------------------------------
  // Fusion des activités importées dans les séances Trail Coach
  // ---------------------------------------------------------------------
  function isDuplicate(sessions, act) {
    return sessions.some(s => {
      if (s.externalId && s.externalId === act.externalId) return true;
      if (!s.done || !s.actual || s.date !== act.date) return false;
      const d1 = s.actual.distance || 0, d2 = act.actual.distance || 0;
      const t1 = s.actual.duree || 0, t2 = act.actual.duree || 0;
      return d1 > 0 && Math.abs(d1 - d2) / d1 < 0.04 && (!t1 || Math.abs(t1 - t2) <= 3);
    });
  }

  /** Transforme une activité importée en séance réalisée de l'historique. */
  function activityToSession(act, uid) {
    return {
      id: uid(), type: act.type, date: act.date,
      distance: act.actual.distance, dplus: act.actual.dplus, duree: act.actual.duree,
      notes: act.name ? act.name : "", done: true, actual: Object.assign({ feeling: null }, act.actual),
      generated: false, source: act.source, externalId: act.externalId,
    };
  }

  // ---------------------------------------------------------------------
  // Analyse de charge
  // ---------------------------------------------------------------------
  const CROSS = { renfo: 1, velo: 1, natation: 1, autre: 1 };
  const TYPE_RPE = { recup: 2, fonda: 3, longue: 4, seuil: 6, fractionne: 7, cotes: 6.5, renfo: 4, velo: 3, natation: 3, autre: 4 };

  function val(s, k) { return s.actual && s.actual[k] != null ? s.actual[k] : s[k]; }
  function kmEffort(s) { return (val(s, "distance") || 0) + (val(s, "dplus") || 0) / 100; }

  /**
   * Charge d'une séance, en « unités de charge » (~ minutes × intensité).
   * - si FC moyenne + FC max/repos connues : TRIMP de Banister ;
   * - sinon : durée × ressenti (méthode sRPE de Foster, ressenti 1-5 ramené sur 10) ;
   * - à défaut de ressenti : intensité typique du type de séance.
   */
  function sessionLoad(s, profile) {
    const duree = val(s, "duree") || (val(s, "distance") ? val(s, "distance") * 6.5 : 0);
    if (!duree) return 0;
    const fc = s.actual && s.actual.fc;
    const p = profile || {};
    if (fc && p.fcMax && p.fcRepos && p.fcMax > p.fcRepos && !CROSS[s.type]) {
      const r = Math.min(1, Math.max(0, (fc - p.fcRepos) / (p.fcMax - p.fcRepos)));
      return Math.round(duree * r * 0.64 * Math.exp(1.92 * r) * 1.6);
    }
    const feel = s.actual && s.actual.feeling;
    let rpe = feel ? feel * 2 : (TYPE_RPE[s.type] || 3.5);
    if (CROSS[s.type]) rpe *= 0.7;
    return Math.round(duree * rpe / 2.5);
  }

  /** Séries quotidiennes forme (42 j) / fatigue (7 j) / fraîcheur. */
  function loadSeries(sessions, profile, days) {
    days = days || 120;
    const daily = {};
    sessions.forEach(s => {
      if (!s.done || !s.date) return;
      daily[s.date] = (daily[s.date] || 0) + sessionLoad(s, profile);
    });
    const today = toISO(new Date());
    let d = addDaysISO(today, -(days + 150));
    let ctl = 0, atl = 0;
    const kc = 1 - Math.exp(-1 / 42), ka = 1 - Math.exp(-1 / 7);
    const out = [];
    while (d <= today) {
      const load = daily[d] || 0;
      const tsb = ctl - atl;
      ctl += (load - ctl) * kc;
      atl += (load - atl) * ka;
      out.push({ date: d, load, forme: round1(ctl), fatigue: round1(atl), fraicheur: round1(tsb) });
      d = addDaysISO(d, 1);
    }
    return out.slice(-days);
  }

  function formState(p) {
    if (!p || p.forme < 3) return { key: "inconnu", label: "Pas assez de données", advice: "Importe tes dernières semaines pour que l'analyse soit fiable.", color: "var(--muted)" };
    const rel = p.fraicheur / Math.max(1, p.forme);
    if (rel > 0.25) return { key: "frais", label: "Très frais", advice: "Bien reposé : bon moment pour une séance clé. Si ça dure, la forme s'érode.", color: "var(--blue)" };
    if (rel > -0.1) return { key: "equilibre", label: "Équilibré", advice: "Forme et fatigue s'équilibrent : suis le plan normalement.", color: "var(--green)" };
    if (rel > -0.3) return { key: "productif", label: "Charge productive", advice: "Fatigue d'entraînement normale : c'est là que la forme se construit.", color: "var(--accent)" };
    if (rel > -0.5) return { key: "fatigue", label: "Fatigue marquée", advice: "Privilégie l'endurance fondamentale et le sommeil quelques jours.", color: "var(--accent2)" };
    return { key: "surcharge", label: "Surcharge", advice: "Risque de blessure ou de surmenage : allège nettement la semaine.", color: "var(--accent2)" };
  }

  /** Plus gros effort récent (≥ 60 km ou ≥ 7 h) dans les 60 derniers jours. */
  function recentUltra(sessions) {
    const limite = addDaysISO(toISO(new Date()), -60);
    const c = sessions.filter(s => s.done && !CROSS[s.type] && (s.date || "") >= limite &&
      ((val(s, "distance") || 0) >= 60 || (val(s, "duree") || 0) >= 420));
    if (!c.length) return null;
    c.sort((a, b) => b.date.localeCompare(a.date));
    const s = c[0];
    const jours = Math.round((Date.parse(toISO(new Date())) - Date.parse(s.date)) / 86400000);
    const km = val(s, "distance") || 0;
    // Repère courant : ~1 semaine de récupération par tranche de 35 km-effort
    // d'ultra (100 km / 4 800 m D+ ≈ 148 km-effort ≈ 4 semaines)
    const semainesRecup = Math.min(6, Math.max(2, Math.round(kmEffort(s) / 35)));
    const phase = jours < 10 ? "Récupération active (marche, vélo léger, footings très courts)"
      : jours < semainesRecup * 7 ? "Reprise progressive : endurance fondamentale uniquement"
      : "Récupération terminée : retour possible à des séances de qualité";
    return { session: s, jours, km, dplus: val(s, "dplus") || 0, semainesRecup, phase };
  }

  function weeklyStats(sessions, weeks) {
    weeks = weeks || 12;
    const map = {};
    let w = mondayISO(new Date());
    const order = [];
    for (let i = 0; i < weeks; i++) { map[w] = { week: w, km: 0, dplus: 0, kmEffort: 0, min: 0, n: 0 }; order.unshift(w); w = addDaysISO(w, -7); }
    sessions.forEach(s => {
      if (!s.done || !s.date) return;
      const e = map[mondayISO(s.date)];
      if (!e) return;
      if (!CROSS[s.type]) { e.km += val(s, "distance") || 0; e.dplus += val(s, "dplus") || 0; e.kmEffort += kmEffort(s); }
      e.min += val(s, "duree") || 0; e.n++;
    });
    return order.map(k => ({ week: k, km: round1(map[k].km), dplus: Math.round(map[k].dplus), kmEffort: round1(map[k].kmEffort), heures: round1(map[k].min / 60), n: map[k].n }));
  }

  /** Estimation de VMA à partir des tours rapides (3 à 8 min) avec FC élevée. */
  function estimateVma(sessions, fcMax) {
    const limite = addDaysISO(toISO(new Date()), -120);
    let best = null;
    sessions.forEach(s => {
      if (!s.done || (s.date || "") < limite || !s.actual || !s.actual.laps) return;
      s.actual.laps.forEach(l => {
        if (l.sec < 180 || l.sec > 480 || !l.m) return;
        if (fcMax && l.fc && l.fc < fcMax * 0.88) return;
        const kmh = (l.m / l.sec) * 3.6;
        // un effort de 3 à 8 min se court à ~95-100 % de VMA
        const vma = kmh / (l.sec <= 300 ? 0.98 : 0.94);
        if (vma > 8 && vma < 25 && (!best || vma > best.vma)) best = { vma: round1(vma), date: s.date };
      });
    });
    return best;
  }

  function analyse(sessions, profile) {
    const series = loadSeries(sessions, profile, 120);
    const cur = series[series.length - 1];
    const weeks = weeklyStats(sessions, 12);
    const last4 = weeks.slice(-5, -1);
    return {
      series, current: cur, state: formState(cur), weeks,
      moy4: {
        km: round1(avg(last4.map(w => w.km)) || 0),
        dplus: Math.round(avg(last4.map(w => w.dplus)) || 0),
        kmEffort: round1(avg(last4.map(w => w.kmEffort)) || 0),
      },
      ultra: recentUltra(sessions),
      vma: estimateVma(sessions, profile && profile.fcMax),
    };
  }

  window.TCP = {
    toISO, addDaysISO, mondayISO, decodeFit, parseActivityFile, parseFitFile, parseGpxText, parseTcxText,
    buildActivity, guessType, getLocal, setLocal,
    stravaAuthorizeUrl, stravaHandleRedirect, stravaRecent, stravaWithLaps, stravaRedirectUri,
    isDuplicate, activityToSession, sessionLoad, loadSeries, formState, recentUltra, weeklyStats, estimateVma, analyse, kmEffort,
  };
})();
