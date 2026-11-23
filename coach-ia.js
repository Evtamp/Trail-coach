/* ======================================================================
   Coach IA de Trail Coach : Claude lit tes séances et ton analyse de
   charge, répond à tes questions et peut ajuster ton plan via des outils.

   La clé API Anthropic est saisie dans l'app et stockée uniquement dans
   le localStorage de cet appareil (jamais synchronisée dans Firebase).
   ====================================================================== */
(function () {
  "use strict";

  const MODEL = "claude-opus-5-5";
  // Deux niveaux : le coach complet, et un mode éco environ 40 fois moins cher.
  // Prix en $ par million de tokens : entrée, sortie, lecture et écriture du cache.
  const MODELES = {
    complet: { id: "claude-opus-5-5", label: "Complet (Opus 5.5)", prix: { in: 4, out: 20, read: 0.2, write: 5 }, fallback: true },
    eco: { id: "claude-haiku-5-5", label: "Éco (Haiku 5.5)", prix: { in: 0.1, out: 0.5, read: 0.01, write: 0.125 }, fallback: false },
  };
  function modeCoach() { const m = (window.TCP.getLocal() || {}).coachMode; return MODELES[m] ? m : "complet"; }
  function coutUsd(u, prix) {
    if (!u) return 0;
    return ((u.input_tokens || 0) * prix.in + (u.output_tokens || 0) * prix.out
      + (u.cache_read_input_tokens || 0) * prix.read + (u.cache_creation_input_tokens || 0) * prix.write) / 1e6;
  }
  /** Cumul du mois, sur cet appareil. */
  function ajouterDepense(usd) {
    const mois = window.TCP.toISO(new Date()).slice(0, 7);
    const d = (window.TCP.getLocal() || {}).coachSpend || {};
    const total = (d.mois === mois ? d.usd || 0 : 0) + usd;
    const n = (d.mois === mois ? d.n || 0 : 0) + 1;
    window.TCP.setLocal({ coachSpend: { mois, usd: total, n } });
    return { mois, usd: total, n };
  }
  const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.12.0/+esm";
  const HISTORY_KEY = "trailcoach:coach-history";
  const MAX_STEPS = 10;

  let sdkPromise = null;
  function loadSdk() {
    if (!sdkPromise) sdkPromise = import(SDK_URL).then(m => m.default || m.Anthropic);
    return sdkPromise;
  }

  // ---------------------------------------------------------------------
  // Historique de conversation (blocs de contenu conservés tels quels)
  // ---------------------------------------------------------------------
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch (e) { return []; }
  }
  function saveHistory(messages) {
    // On garde ~60 messages, en coupant toujours avant une question de
    // l'utilisateur pour ne jamais séparer un appel d'outil de son résultat.
    let msgs = messages;
    if (msgs.length > 60) {
      let i = msgs.length - 60;
      while (i < msgs.length && !(msgs[i].role === "user" && typeof msgs[i].content === "string")) i++;
      msgs = msgs.slice(i);
    }
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(msgs)); } catch (e) { /* quota plein */ }
    return msgs;
  }
  function clearHistory() { localStorage.removeItem(HISTORY_KEY); }

  // ---------------------------------------------------------------------
  // Outils mis à disposition du coach
  // ---------------------------------------------------------------------
  const TYPE_ENUM = ["longue", "fractionne", "cotes", "seuil", "fonda", "recup", "trail", "course", "repos", "renfo", "velo", "hometrainer", "natation", "basket", "pickleball", "autre"];

  const TOOLS = [
    {
      name: "lire_etat_athlete",
      description: "Renvoie l'objectif, la VMA, le profil cardio, l'analyse de charge (forme, fatigue, fraîcheur), les volumes des 12 dernières semaines (km, D+, km-effort), la détection d'un ultra récent et les dernières évaluations hebdomadaires du plan. À appeler en premier pour toute question d'entraînement.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "lister_seances",
      description: "Liste les séances (réalisées et/ou prévues) avec leur identifiant, type, date ou semaine, valeurs prévues et réalisées. Les séances prévues sans date sont à placer librement dans leur semaine (weekStart = lundi).",
      input_schema: {
        type: "object",
        properties: {
          statut: { type: "string", enum: ["realisees", "a_venir", "toutes"], description: "Filtre sur l'état des séances." },
          depuis: { type: "string", description: "Date ISO AAAA-MM-JJ de début (incluse)." },
          jusqu_a: { type: "string", description: "Date ISO AAAA-MM-JJ de fin (incluse)." },
        },
        required: ["statut"],
        additionalProperties: false,
      },
    },
    {
      name: "detail_seance",
      description: "Détail complet d'une séance : tours (durée, distance, FC), ressenti, notes, ravitaillement.",
      input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    },
    {
      name: "modifier_seance",
      description: "Modifie une séance À VENIR (non réalisée) du plan : type, distance (km), D+ (m), durée (min), date, notes. Indique toujours la raison, elle est affichée à l'athlète.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: TYPE_ENUM },
          distance: { type: "number", description: "km" },
          dplus: { type: "number", description: "mètres de D+" },
          duree: { type: "number", description: "minutes" },
          date: { type: "string", description: "AAAA-MM-JJ, ou chaîne vide pour laisser le jour libre" },
          notes: { type: "string", description: "Consignes de séance (allures, structure)." },
          raison: { type: "string", description: "Pourquoi ce changement, en une phrase." },
        },
        required: ["id", "raison"],
        additionalProperties: false,
      },
    },
    {
      name: "ajouter_seance",
      description: "Ajoute une séance prévue au plan, dans la semaine indiquée (lundi AAAA-MM-JJ) ou à une date précise.",
      input_schema: {
        type: "object",
        properties: {
          type: { type: "string", enum: TYPE_ENUM },
          semaine: { type: "string", description: "Lundi de la semaine, AAAA-MM-JJ" },
          date: { type: "string", description: "Date précise AAAA-MM-JJ (optionnelle)" },
          distance: { type: "number" },
          dplus: { type: "number" },
          duree: { type: "number" },
          notes: { type: "string" },
          raison: { type: "string" },
        },
        required: ["type", "semaine", "raison"],
        additionalProperties: false,
      },
    },
    {
      name: "supprimer_seance",
      description: "Supprime une séance À VENIR du plan (jamais une séance réalisée).",
      input_schema: { type: "object", properties: { id: { type: "string" }, raison: { type: "string" } }, required: ["id", "raison"], additionalProperties: false },
    },
  ].map(t => Object.assign({ eager_input_streaming: true }, t));

  function sysPrompt(today) {
    return [
      "Tu es le coach intégré à Trail Coach, l'application d'entraînement personnelle d'un coureur de trail et d'ultra-trail. Tu t'adresses à lui en français, en le tutoyant, avec un ton direct et bienveillant de coach expérimenté.",
      "",
      "Ce que tu fais :",
      "- Tu analyses ses séances importées (montre Garmin, Strava) et l'analyse de charge de l'appli pour répondre à ses questions et l'aider à progresser sans se blesser.",
      "- Tu ajustes son plan avec les outils quand c'est justifié par les données (fatigue élevée, séances manquées, ressenti dur, récupération post-ultra, contrainte de calendrier qu'il t'indique).",
      "- Pour un changement important (plus de 3 séances, ou plus de 20 % du volume d'une semaine), propose d'abord le changement et attends son accord avant d'utiliser les outils. Les petits ajustements, fais-les directement et dis ce que tu as changé.",
      "",
      "Méthode :",
      "- Appuie chaque affirmation sur les chiffres que les outils renvoient, et distingue ce qui est mesuré (montre) de ce qui est estimé (forme/fatigue, VMA estimée, km-effort = km + D+/100).",
      "- La « forme » est une moyenne de charge sur 42 jours, la « fatigue » sur 7 jours, la « fraîcheur » = forme − fatigue de la veille. Une fraîcheur très négative signale un besoin de récupération.",
      "- Après un ultra, la reprise est progressive : pas d'intensité tant que la récupération n'est pas terminée.",
      "- Sans objectif, « semainesProposeesSansObjectif » contient la période (récup, reprise, entretien) et les séances proposées par l'appli pour cette semaine et la suivante : appuie-toi dessus, et propose à l'athlète de les ajouter à son plan (onglet Plan) s'il veut les suivre.",
      "- Si « garmin » est renseigné (données de sa montre via Home Assistant) : disponibilité à l'entraînement, statut, VFC, sommeil, FC repos et Body Battery décrivent sa récupération du jour. Une disponibilité basse (< 40), une VFC « basse » ou sous sa référence, une FC repos au-dessus de sa moyenne ou un mauvais sommeil justifient d'alléger ou de décaler la séance d'intensité du jour ; plusieurs signaux convergents pèsent plus qu'un seul. Croise-les avec la fraîcheur de l'appli.",
      "- Tu n'es pas médecin : en cas de douleur persistante, de malaise ou de signe inquiétant, recommande de consulter.",
      "",
      "Format : réponses courtes et concrètes, en texte simple (listes autorisées, pas de tableaux). Quand tu as modifié le plan, termine par la liste des changements.",
      "",
      "Date du jour : " + today + ".",
    ].join("\n");
  }

  // ---------------------------------------------------------------------
  // Exécution des outils sur l'état de l'application
  // ---------------------------------------------------------------------
  function compact(s) {
    const a = s.actual || {};
    return {
      id: s.id, type: s.type, fait: !!s.done, date: s.date || null, semaine: s.weekStart || null, phase: s.phase || null,
      prevu: { km: s.distance ?? null, dplus: s.dplus ?? null, min: s.duree ?? null },
      realise: s.done ? { km: a.distance ?? null, dplus: a.dplus ?? null, min: a.duree ?? null, ressenti: a.feeling ?? null, fc: a.fc ?? null, fcMax: a.fcMax ?? null, tours: (a.laps || []).length } : undefined,
      notes: s.notes ? String(s.notes).slice(0, 200) : undefined,
      noteCoach: s.coachNote || undefined,
      source: s.source || undefined,
    };
  }

  function isoOk(x) { return typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x); }

  /**
   * ctx : { getState() -> {goal, sessions, evaluations, profile}, setSessions(fn), uid(), onChange(text) }
   */
  function runTool(name, input, ctx) {
    const st = ctx.getState();
    const sessions = st.sessions || [];
    const find = id => sessions.find(s => s.id === id);
    switch (name) {
      case "lire_etat_athlete": {
        const an = window.TCP.analyse(sessions, st.profile);
        const evals = Object.entries(st.evaluations || {}).sort((a, b) => a[0].localeCompare(b[0])).slice(-4)
          .map(([w, e]) => ({ semaine: w, ratioRealise: e.complianceRatio != null ? Math.round(e.complianceRatio * 100) / 100 : null, seancesClesManquees: e.missedKey ?? null, ressentiMoyen: e.avgFeeling ?? null, ajustement: e.reason || null }));
        return {
          objectif: st.goal || null,
          profil: st.profile || {},
          charge: an.current ? { forme: an.current.forme, fatigue: an.current.fatigue, fraicheur: an.current.fraicheur, etat: an.state.label } : null,
          moyenne4Semaines: an.moy4,
          semaines: an.weeks,
          ultraRecent: an.ultra ? { date: an.ultra.session.date, km: an.ultra.km, dplus: an.ultra.dplus, joursDepuis: an.ultra.jours, semainesRecupConseillees: an.ultra.semainesRecup, phase: an.ultra.phase } : null,
          vmaEstimee: an.vma,
          evaluationsRecentes: evals,
          garmin: st.garmin || null,
          semainesProposeesSansObjectif: st.propositions || null,
          records: window.TCP.records ? (r => ({ meilleursTempsSec: r.temps.map(x => ({ distance: x.nom, sec: x.sec, date: x.date })), extremes: r.extremes.map(x => ({ quoi: x.nom, valeur: x.valeur, unite: x.unite, date: x.date })) }))(window.TCP.records(sessions)) : null,
          nbSeancesRealisees: sessions.filter(s => s.done).length,
          nbSeancesAVenir: sessions.filter(s => !s.done).length,
        };
      }
      case "lister_seances": {
        const statut = input.statut || "toutes";
        let list = sessions.filter(s => statut === "toutes" || (statut === "realisees" ? s.done : !s.done));
        const key = s => s.date || s.weekStart || "";
        if (isoOk(input.depuis)) list = list.filter(s => key(s) >= window.TCP.mondayISO(input.depuis) && (s.date ? s.date >= input.depuis : true));
        if (isoOk(input.jusqu_a)) list = list.filter(s => key(s) <= input.jusqu_a);
        list = list.sort((a, b) => key(a).localeCompare(key(b)) || (a.order ?? 99) - (b.order ?? 99));
        const trunc = list.length > 80;
        if (trunc) list = statut === "a_venir" ? list.slice(0, 80) : list.slice(-80);
        return { total: list.length, tronque: trunc, seances: list.map(compact) };
      }
      case "detail_seance": {
        const s = find(input.id);
        if (!s) return { erreur: "Séance introuvable : " + input.id };
        return Object.assign(compact(s), { meilleursTempsSec: (s.actual && s.actual.best) || undefined, traceGps: !!(s.actual && s.actual.trace), tours: (s.actual && s.actual.laps) || [], ravitaillement: s.actual && s.actual.fueling ? s.actual.fueling : undefined, notesCompletes: s.notes || "" });
      }
      case "modifier_seance": {
        const s = find(input.id);
        if (!s) return { erreur: "Séance introuvable : " + input.id };
        if (s.done) return { erreur: "Cette séance est déjà réalisée : on ne modifie que les séances à venir." };
        const patch = {};
        if (input.type && TYPE_ENUM.includes(input.type)) patch.type = input.type;
        ["distance", "dplus", "duree"].forEach(k => { if (typeof input[k] === "number" && input[k] >= 0) patch[k] = Math.round(input[k] * 10) / 10; });
        if (typeof input.date === "string") {
          if (input.date === "") patch.date = null;
          else if (isoOk(input.date)) { patch.date = input.date; patch.weekStart = window.TCP.mondayISO(input.date); }
        }
        if (typeof input.notes === "string") patch.notes = input.notes;
        patch.coachNote = String(input.raison || "").slice(0, 300);
        patch.coachEdited = true;
        ctx.setSessions(prev => prev.map(x => x.id === s.id ? Object.assign({}, x, patch) : x));
        ctx.onChange && ctx.onChange("Séance modifiée (" + (patch.type || s.type) + ") : " + patch.coachNote);
        return { ok: true, seance: compact(Object.assign({}, s, patch)) };
      }
      case "ajouter_seance": {
        if (!TYPE_ENUM.includes(input.type)) return { erreur: "Type inconnu." };
        const week = isoOk(input.date) ? window.TCP.mondayISO(input.date) : isoOk(input.semaine) ? window.TCP.mondayISO(input.semaine) : null;
        if (!week) return { erreur: "Indique la semaine (lundi AAAA-MM-JJ)." };
        const s = {
          id: ctx.uid(), type: input.type, date: isoOk(input.date) ? input.date : null, weekStart: week, order: 50,
          distance: typeof input.distance === "number" ? input.distance : null,
          dplus: typeof input.dplus === "number" ? input.dplus : null,
          duree: typeof input.duree === "number" ? input.duree : null,
          notes: input.notes || "", done: false, actual: null, generated: false,
          coachNote: String(input.raison || "").slice(0, 300), coachEdited: true,
        };
        ctx.setSessions(prev => prev.concat([s]));
        ctx.onChange && ctx.onChange("Séance ajoutée (" + s.type + ", semaine du " + week + ") : " + s.coachNote);
        return { ok: true, seance: compact(s) };
      }
      case "supprimer_seance": {
        const s = find(input.id);
        if (!s) return { erreur: "Séance introuvable : " + input.id };
        if (s.done) return { erreur: "Impossible de supprimer une séance réalisée." };
        ctx.setSessions(prev => prev.filter(x => x.id !== s.id));
        ctx.onChange && ctx.onChange("Séance supprimée (" + s.type + ") : " + (input.raison || ""));
        return { ok: true };
      }
      default:
        return { erreur: "Outil inconnu : " + name };
    }
  }

  // Le streaming des arguments d'outil est activé : on revérifie que les
  // champs obligatoires sont bien présents avant d'exécuter quoi que ce soit.
  function validateInput(name, input) {
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) return "Outil inconnu.";
    if (!input || typeof input !== "object") return "Arguments invalides (JSON attendu).";
    const req = tool.input_schema.required || [];
    const missing = req.filter(k => input[k] === undefined || input[k] === null);
    return missing.length ? "Champ(s) manquant(s) : " + missing.join(", ") : null;
  }

  // ---------------------------------------------------------------------
  // Boucle de conversation
  // ---------------------------------------------------------------------
  /**
   * Envoie le message de l'utilisateur et laisse le coach travailler
   * (appels d'outils compris) jusqu'à sa réponse finale.
   * handlers : { onText(delta), onToolStart(name), onChange(text), onDone(messages) }
   */
  async function ask(userText, ctx, handlers) {
    const apiKey = (window.TCP.getLocal().anthropicKey || "").trim();
    if (!apiKey) throw new Error("Ajoute ta clé API Anthropic dans les réglages du coach.");
    const Anthropic = await loadSdk();
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

    let messages = loadHistory().concat([{ role: "user", content: userText }]);
    const today = window.TCP.toISO(new Date());

    const mode = MODELES[modeCoach()];
    let usd = 0;
    for (let step = 0; step < MAX_STEPS; step++) {
      const params = {
        model: mode.id,
        max_tokens: 16000,
        output_config: { effort: "medium" },
        // mise en cache automatique : consignes, outils et début de conversation
        // ne sont facturés plein tarif qu'une fois par question
        cache_control: { type: "ephemeral" },
        system: sysPrompt(today),
        tools: TOOLS,
        messages,
      };
      if (mode.fallback) { params.betas = ["server-side-fallback-2026-07-01"]; params.fallbacks = "default"; }
      const stream = client.beta.messages.stream(params);
      stream.on("text", t => handlers.onText && handlers.onText(t));
      const msg = await stream.finalMessage();
      usd += coutUsd(msg.usage, mode.prix);

      // Le contenu est renvoyé tel quel (blocs de réflexion compris)
      messages = messages.concat([{ role: "assistant", content: msg.content }]);

      if (msg.stop_reason === "refusal") {
        handlers.onText && handlers.onText("\n\n(Le coach n'a pas pu répondre à cette demande.)");
        break;
      }
      if (msg.stop_reason === "max_tokens") {
        handlers.onText && handlers.onText("\n\n(Réponse tronquée : trop longue.)");
        break;
      }
      if (msg.stop_reason !== "tool_use") break;

      const results = [];
      for (const block of msg.content) {
        if (block.type !== "tool_use") continue;
        handlers.onToolStart && handlers.onToolStart(block.name);
        const err = validateInput(block.name, block.input);
        let out;
        if (err) out = { content: err, is_error: true };
        else {
          try { out = { content: JSON.stringify(runTool(block.name, block.input, Object.assign({}, ctx, { onChange: handlers.onChange }))) }; }
          catch (e) { out = { content: "Erreur : " + (e.message || e), is_error: true }; }
        }
        results.push(Object.assign({ type: "tool_result", tool_use_id: block.id }, out));
      }
      messages = messages.concat([{ role: "user", content: results }]);
      handlers.onText && handlers.onText("\n");
    }
    messages = saveHistory(messages);
    const cumul = ajouterDepense(usd);
    handlers.onCost && handlers.onCost({ usd, cumul, modele: mode.label });
    handlers.onDone && handlers.onDone(messages);
    return messages;
  }

  // ---------------------------------------------------------------------
  // Variante gratuite : Gemini (Google AI Studio), mêmes outils
  // ---------------------------------------------------------------------
  const GEMINI_HISTORY_KEY = "trailcoach:coach-history-gemini";
  const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
  function fournisseur() { return (window.TCP.getLocal() || {}).coachProvider === "gemini" ? "gemini" : "claude"; }
  function loadGemini() { try { return JSON.parse(localStorage.getItem(GEMINI_HISTORY_KEY) || "[]"); } catch (e) { return []; } }
  function saveGemini(contents) {
    let c = contents;
    if (c.length > 60) {
      let i = c.length - 60;
      while (i < c.length && !(c[i].role === "user" && c[i].parts && c[i].parts[0] && c[i].parts[0].text != null)) i++;
      c = c.slice(i);
    }
    try { localStorage.setItem(GEMINI_HISTORY_KEY, JSON.stringify(c)); } catch (e) {}
    return c;
  }
  // Schéma des outils au format Gemini (sous-ensemble OpenAPI : pas d'additionalProperties)
  function geminiSchema(sch) {
    if (Array.isArray(sch)) return sch.map(geminiSchema);
    if (!sch || typeof sch !== "object") return sch;
    const out = {};
    Object.keys(sch).forEach(k => { if (k !== "additionalProperties") out[k] = geminiSchema(sch[k]); });
    return out;
  }
  /**
   * Les noms des modèles Gemini changent souvent : on demande la liste à
   * Google et on prend le Flash (gratuit) le plus récent, mis en cache 1 jour.
   */
  async function geminiModele(key) {
    const loc = window.TCP.getLocal() || {};
    if (loc.geminiModel && loc.geminiModelAt && Date.now() - loc.geminiModelAt < 86400000) return loc.geminiModel;
    let choix = "gemini-flash-latest";
    try {
      const r = await fetch(GEMINI_API + "/models?pageSize=200", { headers: { "x-goog-api-key": key } });
      if (r.ok) {
        const j = await r.json();
        const ok = (j.models || []).filter(m => (m.supportedGenerationMethods || []).indexOf("generateContent") >= 0)
          .map(m => m.name.replace(/^models\//, ""))
          .filter(n => /^gemini-[\d.]+-flash$/.test(n) || /^gemini-[\d.]+-flash-\d{3}$/.test(n));
        const ver = n => parseFloat((n.match(/gemini-([\d.]+)/) || [])[1] || 0);
        ok.sort((a, b) => ver(b) - ver(a) || a.length - b.length);
        if (ok.length) choix = ok[0];
      }
    } catch (e) {}
    window.TCP.setLocal({ geminiModel: choix, geminiModelAt: Date.now() });
    return choix;
  }

  async function askGemini(userText, ctx, handlers) {
    const key = ((window.TCP.getLocal() || {}).geminiKey || "").trim();
    if (!key) throw new Error("Ajoute ta clé Gemini dans les réglages du coach.");
    const modele = await geminiModele(key);
    const today = window.TCP.toISO(new Date());
    let contents = loadGemini().concat([{ role: "user", parts: [{ text: userText }] }]);
    const tools = [{ functionDeclarations: TOOLS.map(t => { const d = { name: t.name, description: t.description }; if (Object.keys(t.input_schema.properties || {}).length) d.parameters = geminiSchema(t.input_schema); return d; }) }];
    for (let step = 0; step < MAX_STEPS; step++) {
      const r = await fetch(GEMINI_API + "/models/" + modele + ":generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: sysPrompt(today) }] }, contents, tools }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const m = (j.error && j.error.message) || ("HTTP " + r.status);
        if (r.status === 404) window.TCP.setLocal({ geminiModelAt: 0 });
        if (r.status === 429) throw new Error("Quota gratuit Gemini atteint pour le moment : réessaie dans une minute (ou demain si c'est le quota du jour).");
        if (r.status === 400 && /API key/i.test(m)) throw new Error("Clé Gemini refusée : vérifie-la dans les réglages du coach.");
        throw new Error("Gemini : " + m);
      }
      const cand = (j.candidates || [])[0];
      const parts = (cand && cand.content && cand.content.parts) || [];
      // contenu renvoyé tel quel (signatures de réflexion comprises)
      contents = contents.concat([{ role: "model", parts: parts.length ? parts : [{ text: "" }] }]);
      parts.forEach(p => { if (p.text && !p.thought) handlers.onText && handlers.onText(p.text); });
      const calls = parts.filter(p => p.functionCall);
      if (!calls.length) {
        if (!parts.some(p => p.text) && cand && cand.finishReason && cand.finishReason !== "STOP") handlers.onText && handlers.onText("(Gemini n'a pas pu répondre : " + cand.finishReason + ")");
        break;
      }
      const reps = [];
      for (const p of calls) {
        const name = p.functionCall.name, input = p.functionCall.args || {};
        handlers.onToolStart && handlers.onToolStart(name);
        const err = validateInput(name, input);
        let res;
        if (err) res = { erreur: err };
        else {
          try { res = { resultat: runTool(name, input, Object.assign({}, ctx, { onChange: handlers.onChange })) }; }
          catch (e) { res = { erreur: "Erreur : " + (e.message || e) }; }
        }
        reps.push({ functionResponse: { name, response: res } });
      }
      contents = contents.concat([{ role: "user", parts: reps }]);
      handlers.onText && handlers.onText("\n");
    }
    contents = saveGemini(contents);
    handlers.onCost && handlers.onCost({ usd: 0, gratuit: true, modele: modele });
    handlers.onDone && handlers.onDone(contents);
    return contents;
  }

  /** Transforme l'historique en bulles affichables (texte uniquement). */
  function toBubbles(messages) {
    const out = [];
    messages.forEach(m => {
      if (m.parts) { // format Gemini
        const text = m.parts.filter(p => p.text && !p.thought).map(p => p.text).join("").trim();
        if (!text) return;
        if (m.role === "user") { out.push({ role: "user", text }); return; }
        const last = out[out.length - 1];
        if (last && last.role === "assistant") last.text += "\n\n" + text; else out.push({ role: "assistant", text });
        return;
      }
      if (m.role === "user" && typeof m.content === "string") out.push({ role: "user", text: m.content });
      else if (m.role === "assistant" && Array.isArray(m.content)) {
        const text = m.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
        if (!text) return;
        const last = out[out.length - 1];
        if (last && last.role === "assistant") last.text += "\n\n" + text;
        else out.push({ role: "assistant", text });
      }
    });
    return out;
  }

  window.TCP = window.TCP || {};
  /** Texte à coller dans l'appli Claude (gratuit avec l'abonnement) : état + séances récentes et à venir. */
  function exportPourClaude(ctx) {
    const today = window.TCP.toISO(new Date());
    const etat = runTool("lire_etat_athlete", {}, ctx);
    const seances = runTool("lister_seances", { statut: "toutes", depuis: window.TCP.addDaysISO(today, -21), jusqu_a: window.TCP.addDaysISO(today, 14) }, ctx);
    return "Tu es mon coach de trail. Voici mes données d'entraînement exportées de mon appli Trail Coach le " + today
      + ". Appuie-toi sur ces chiffres pour me répondre.\n\nÉTAT (forme, volumes, Garmin, records, semaines proposées) :\n"
      + JSON.stringify(etat) + "\n\nSÉANCES (3 dernières semaines et 2 à venir) :\n" + JSON.stringify(seances)
      + "\n\nMa question : ";
  }

  // point d'entrée unique : Claude ou Gemini selon le réglage
  function askAuto(q, ctx, h) { return fournisseur() === "gemini" ? askGemini(q, ctx, h) : ask(q, ctx, h); }
  function historique() { return fournisseur() === "gemini" ? loadGemini() : loadHistory(); }
  function effacer() { if (fournisseur() === "gemini") localStorage.removeItem(GEMINI_HISTORY_KEY); else clearHistory(); }

  window.TCP.coach = { ask: askAuto, askClaude: ask, askGemini, fournisseur, historique, effacer, loadHistory, clearHistory, toBubbles, runTool, TOOLS, MODEL, MODELES, modeCoach, exportPourClaude };
})();
