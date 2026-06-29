module.exports = function registerTrainingSessionRoutes(app, deps = {}) {
  const { pool, normText, safeArr, normKey, todayISO, isObj, rollbackQuietly, sendDbError } = deps;

/* ============================================================
   Training Session Token API (TEXT token stored in reports.payload.quizToken)
============================================================ */
function extractQuiz(payload) {
  const q = payload?.quiz || payload?.quizData || payload?.trainingQuiz || {};
  const questions = Array.isArray(q?.questions) ? q.questions : Array.isArray(payload?.questions) ? payload.questions : [];
  const module = q?.module || payload?.module || payload?.moduleName || "";
  const passMark = Number(q?.passMark ?? payload?.passMark ?? payload?.PASS_MARK ?? 80);

  return {
    module,
    passMark: Number.isFinite(passMark) ? passMark : 80,
    questions,
  };
}

function makeParticipantKeyFromBody(body) {
  const pk = normText(body?.participantKey);
  const pk2 = normText(body?.participant_key);
  if (pk) return pk;
  if (pk2) return pk2;

  const p = body?.participant || {};
  const employeeId = normText(p?.employeeId);
  const name = normText(p?.name).toLowerCase();

  if (employeeId) return `eid:${employeeId}`;
  if (name) return `name:${name}`;
  return "";
}

function submissionKey(token, participantKey) {
  const pk = normText(participantKey);
  if (pk) return `p:${pk}`;
  return `t:${normText(token)}`;
}

function getSubmission(payload, token, participantKey) {
  const subMap = payload?.quizSubmissions && typeof payload.quizSubmissions === "object" ? payload.quizSubmissions : null;

  if (subMap) {
    const k = submissionKey(token, participantKey);
    if (k && subMap[k]) return subMap[k];
  }

  if (payload?.quizSubmission && payload.quizSubmission?.token === token) return payload.quizSubmission;
  return null;
}

app.get("/api/training-session/by-token/:token", async (req, res) => {
  try {
    const token = normText(req.params.token);
    const pKey = normText(req.query?.p || "");
    if (!token) return res.status(400).json({ ok: false, error: "token required" });

    const q = await pool.query(
      `
      SELECT id, reporter, type, created_at, updated_at, payload
      FROM reports
      WHERE type='training_session'
        AND (payload->>'quizToken') = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [token]
    );

    if (!q.rowCount) return res.status(404).json({ ok: false, error: "SESSION_NOT_FOUND" });

    const r = q.rows[0];
    const payload = r.payload || {};
    const quiz = extractQuiz(payload);

    if (!Array.isArray(quiz.questions) || quiz.questions.length === 0) {
      return res.status(400).json({ ok: false, error: "NO_QUIZ_IN_REPORT" });
    }

    const existing = pKey ? getSubmission(payload, token, pKey) : null;
    const p = payload?.participant || payload?.participants?.[0] || {};

    return res.json({
      ok: true,
      token,
      participant: {
        slNo: normText(p?.slNo),
        name: normText(p?.name),
        designation: normText(p?.designation),
        employeeId: normText(p?.employeeId),
      },
      quiz: {
        module: quiz.module,
        passMark: quiz.passMark,
        questions: quiz.questions,
      },
      alreadySubmitted: !!existing,
      lastSubmittedAt: existing?.submittedAt || existing?.submitted_at || null,
    });
  } catch (e) {
    console.error("GET /api/training-session/by-token/:token ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/training-session/by-token/:token/submit", async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const token = normText(req.params.token);
    if (!token) return res.status(400).json({ ok: false, error: "token required" });

    const answers = safeArr(req.body?.answers);
    if (!answers.length) return res.status(400).json({ ok: false, error: "answers required" });

    const participant = isObj(req.body?.participant) ? req.body.participant : {};
    const pName = normText(participant?.name);
    const pDesignation = normText(participant?.designation);
    const pEmployeeId = normText(participant?.employeeId);

    const pKey = makeParticipantKeyFromBody(req.body);
    if (!pKey) return res.status(400).json({ ok: false, error: "participantKey required (or participant.employeeId/name)" });
    if (!pName) return res.status(400).json({ ok: false, error: "participant.name required" });
    if (!pEmployeeId) return res.status(400).json({ ok: false, error: "participant.employeeId required" });

    await client.query("BEGIN");

    const q = await client.query(
      `
      SELECT id, payload
      FROM reports
      WHERE type='training_session'
        AND (payload->>'quizToken') = $1
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
      `,
      [token]
    );

    if (!q.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "SESSION_NOT_FOUND" });
    }

    const reportId = q.rows[0].id;
    const payload = q.rows[0].payload || {};
    const quiz = extractQuiz(payload);

    if (!Array.isArray(quiz.questions) || quiz.questions.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "NO_QUIZ_IN_REPORT" });
    }

    const existing = getSubmission(payload, token, pKey);
    if (existing) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "ALREADY_SUBMITTED",
        score: existing?.score ?? null,
        result: existing?.result ?? null,
        submittedAt: existing?.submittedAt ?? null,
      });
    }

    if (answers.length !== quiz.questions.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "ANSWERS_LENGTH_MISMATCH",
        expected: quiz.questions.length,
        got: answers.length,
      });
    }

    for (let i = 0; i < answers.length; i++) {
      if (!Number.isInteger(answers[i])) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, error: `INVALID_ANSWER_AT_${i}` });
      }
    }

    let correctCount = 0;
    for (let i = 0; i < quiz.questions.length; i++) {
      const c = Number(quiz.questions[i]?.correct);
      if (Number.isFinite(c) && answers[i] === c) correctCount++;
    }

    const score = Math.round((correctCount / quiz.questions.length) * 100);
    const passMark = quiz.passMark;
    const result = score >= passMark ? "PASS" : "FAIL";
    const submittedAt = new Date().toISOString();

    const attemptSnapshot = {
      module: quiz.module || "",
      submittedAt,
      passMark,
      score,
      result,
      answers: quiz.questions.map((qq, i) => ({
        q_ar: qq?.q_ar || "",
        q_en: qq?.q_en || "",
        options_ar: Array.isArray(qq?.options_ar) ? qq.options_ar : [],
        options_en: Array.isArray(qq?.options_en) ? qq.options_en : [],
        correct: Number.isFinite(Number(qq?.correct)) ? Number(qq.correct) : 0,
        chosen: answers[i],
      })),
    };

    const submission = {
      token,
      participantKey: pKey,
      participant: { name: pName, designation: pDesignation, employeeId: pEmployeeId },
      submittedAt,
      passMark,
      score,
      result,
      answers,
    };

    const subMap = payload?.quizSubmissions && typeof payload.quizSubmissions === "object" ? payload.quizSubmissions : {};
    const subKey = submissionKey(token, pKey);

    const participants = safeArr(payload?.participants);
    const eidKey = normKey(pEmployeeId);
    const nameKey = normKey(pName);

    let found = false;
    const updatedParticipants = participants.map((pp) => {
      const ppEid = normKey(pp?.employeeId || "");
      const ppName = normKey(pp?.name || "");

      const hit = (eidKey && ppEid && ppEid === eidKey) || (!eidKey && ppName && ppName === nameKey);
      if (!hit) return pp;

      found = true;
      return {
        ...pp,
        name: pName || pp?.name || "",
        designation: pDesignation || pp?.designation || "",
        employeeId: pEmployeeId || pp?.employeeId || "",
        score: String(score),
        result: String(result).toUpperCase(),
        lastQuizAt: todayISO(),
        quizAttempt: attemptSnapshot,
      };
    });

    let finalParticipants = updatedParticipants;
    if (!found) {
      finalParticipants = updatedParticipants.concat([
        {
          slNo: String(updatedParticipants.length + 1),
          name: pName,
          designation: pDesignation,
          employeeId: pEmployeeId,
          score: String(score),
          result: String(result).toUpperCase(),
          lastQuizAt: todayISO(),
          quizAttempt: attemptSnapshot,
        },
      ]);
    }

    const newPayload = {
      ...payload,
      participants: finalParticipants,
      quizSubmissions: { ...subMap, [subKey]: submission },
    };

    await client.query(`UPDATE reports SET payload=$1::jsonb, updated_at=now() WHERE id=$2`, [
      JSON.stringify(newPayload),
      reportId,
    ]);

    await client.query("COMMIT");

    return res.json({
      ok: true,
      reportId,
      participantKey: pKey,
      score,
      result,
      passMark,
      submittedAt,
    });
  } catch (e) {
    await rollbackQuietly(client);
    console.error("POST /api/training-session/by-token/:token/submit ERROR =", e);
    return sendDbError(res, e);
  } finally {
    if (client) client.release();
  }
});
};
