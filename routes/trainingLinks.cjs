module.exports = function registerTrainingLinkRoutes(app, deps = {}) {
  const { pool, clampInt, normText, safeArr, normKey, todayISO, rollbackQuietly, sendDbError } = deps;

/* ============================================================
   Training Links API (UUID token system - still kept)
============================================================ */
app.post("/api/training-links", async (req, res) => {
  try {
    const reportId = Number(req.body?.reportId);
    const module = normText(req.body?.module || "");
    const expiresInDays = clampInt(req.body?.expiresInDays, 7, 1, 90);
    const participants = safeArr(req.body?.participants);

    if (!Number.isFinite(reportId) || reportId <= 0) {
      return res.status(400).json({ ok: false, error: "reportId required" });
    }
    if (!participants.length) {
      return res.status(400).json({ ok: false, error: "participants required" });
    }

    const r = await pool.query(`SELECT id, type, payload FROM reports WHERE id=$1`, [reportId]);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "report not found" });

    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();

    const created = [];
    for (const p of participants) {
      const slNo = normText(p?.slNo);
      const name = normText(p?.name);
      if (!name) continue;

      const ins = await pool.query(
        `INSERT INTO training_links (report_id, participant_slno, participant_name, module, expires_at, meta)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         RETURNING token, report_id, participant_slno, participant_name, module, expires_at, created_at, used_at`,
        [reportId, slNo || null, name, module || null, expiresAt, JSON.stringify({ createdBy: "admin" })]
      );
      created.push(ins.rows[0]);
    }

    if (!created.length) {
      return res.status(400).json({ ok: false, error: "no valid participants (name required)" });
    }

    return res.status(201).json({ ok: true, reportId, count: created.length, links: created });
  } catch (e) {
    console.error("POST /api/training-links ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/training-links/:token", async (req, res) => {
  try {
    const token = normText(req.params.token);
    if (!token) return res.status(400).json({ ok: false, error: "token required" });

    const q = await pool.query(
      `SELECT token, report_id, participant_slno, participant_name, module, created_at, expires_at, used_at, meta
         FROM training_links
        WHERE token = $1::uuid`,
      [token]
    );
    if (!q.rowCount) return res.status(404).json({ ok: false, error: "invalid token" });

    const link = q.rows[0];

    if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ ok: false, error: "TOKEN_EXPIRED" });
    }

    const r = await pool.query(
      `SELECT id, reporter, type, created_at, updated_at,
              payload->>'title' AS "title",
              payload->>'branch' AS "branch",
              payload->>'module' AS "module",
              payload->>'reportDate' AS "reportDate",
              payload
         FROM reports
        WHERE id=$1`,
      [link.report_id]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "report not found" });

    const report = r.rows[0];

    return res.json({
      ok: true,
      link: {
        token: link.token,
        reportId: link.report_id,
        participant: {
          slNo: link.participant_slno || "",
          name: link.participant_name || "",
        },
        module: link.module || "",
        createdAt: link.created_at,
        expiresAt: link.expires_at,
        usedAt: link.used_at,
      },
      report: {
        id: report.id,
        type: report.type,
        created_at: report.created_at,
        updated_at: report.updated_at,
        title: report.title || report.payload?.title || "",
        branch: report.branch || report.payload?.branch || "",
        module: report.module || report.payload?.module || "",
        reportDate: report.reportDate || report.payload?.reportDate || "",
      },
    });
  } catch (e) {
    console.error("GET /api/training-links/:token ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/training-links/:token/submit", async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const token = normText(req.params.token);
    if (!token) return res.status(400).json({ ok: false, error: "token required" });

    const score = Number(req.body?.score);
    const result = normText(req.body?.result);
    const passMark = Number(req.body?.passMark);
    const module = normText(req.body?.module || "");
    const answers = safeArr(req.body?.answers);

    if (!Number.isFinite(score)) return res.status(400).json({ ok: false, error: "score required" });
    if (!result) return res.status(400).json({ ok: false, error: "result required" });
    if (!Number.isFinite(passMark)) return res.status(400).json({ ok: false, error: "passMark required" });
    if (!answers.length) return res.status(400).json({ ok: false, error: "answers required" });

    await client.query("BEGIN");

    const q1 = await client.query(
      `SELECT token, report_id, participant_slno, participant_name, module, expires_at, used_at
         FROM training_links
        WHERE token = $1::uuid
        FOR UPDATE`,
      [token]
    );
    if (!q1.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "invalid token" });
    }

    const link = q1.rows[0];

    if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
      await client.query("ROLLBACK");
      return res.status(410).json({ ok: false, error: "TOKEN_EXPIRED" });
    }

    if (link.used_at) {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "TOKEN_ALREADY_USED" });
    }

    const q2 = await client.query(`SELECT id, payload FROM reports WHERE id=$1 FOR UPDATE`, [link.report_id]);
    if (!q2.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "report not found" });
    }

    const payload = q2.rows[0].payload || {};
    const participants = safeArr(payload.participants);

    const targetSl = normKey(link.participant_slno || "");
    const targetName = normKey(link.participant_name || "");

    const updatedParticipants = participants.map((p) => {
      const pSl = normKey(p?.slNo || "");
      const pName = normKey(p?.name || "");

      const hit =
        (targetSl && pSl && pSl === targetSl) ||
        (!targetSl && targetName && pName === targetName) ||
        (targetSl && targetName && pSl === targetSl && pName === targetName);

      if (!hit) return p;

      const attemptSnapshot = {
        module: module || link.module || payload.module || "",
        submittedAt: new Date().toISOString(),
        passMark,
        score,
        result,
        answers,
      };

      return {
        ...p,
        score: String(score),
        result: String(result).toUpperCase(),
        lastQuizAt: todayISO(),
        quizAttempt: attemptSnapshot,
      };
    });

    const found = updatedParticipants.some((p) => {
      const pSl = normKey(p?.slNo || "");
      const pName = normKey(p?.name || "");
      return (targetSl && pSl === targetSl) || (targetName && pName === targetName);
    });

    let finalParticipants = updatedParticipants;
    if (!found) {
      finalParticipants = updatedParticipants.concat([
        {
          slNo: link.participant_slno || "",
          name: link.participant_name || "",
          designation: "",
          score: String(score),
          result: String(result).toUpperCase(),
          lastQuizAt: todayISO(),
          quizAttempt: {
            module: module || link.module || payload.module || "",
            submittedAt: new Date().toISOString(),
            passMark,
            score,
            result,
            answers,
          },
        },
      ]);
    }

    const newPayload = {
      ...payload,
      participants: finalParticipants,
    };

    await client.query(
      `UPDATE reports
          SET payload=$1::jsonb, updated_at=now()
        WHERE id=$2`,
      [newPayload, link.report_id]
    );

    await client.query(`UPDATE training_links SET used_at=now() WHERE token=$1::uuid`, [token]);

    await client.query("COMMIT");

    return res.json({
      ok: true,
      reportId: link.report_id,
      participant: { slNo: link.participant_slno || "", name: link.participant_name || "" },
      saved: { score, result: String(result).toUpperCase(), passMark },
    });
  } catch (e) {
    await rollbackQuietly(client);
    console.error("POST /api/training-links/:token/submit ERROR =", e);
    return sendDbError(res, e);
  } finally {
    if (client) client.release();
  }
});
};
