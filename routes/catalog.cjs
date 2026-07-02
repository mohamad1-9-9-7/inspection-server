module.exports = function registerCatalogRoutes(app, deps = {}) {
  const { pool, clampInt, normText, safeObj, rollbackQuietly, sendDbError } = deps;

/* ============================================================
   Product Catalog API
============================================================ */
function catalogRowToClient(row) {
  return {
    scope: row.scope,
    code: row.code,
    name: row.name,
    item_code: row.code,
    description: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function catalogScope(req, fallback = "returns_items") {
  return normText(req.body?.scope || req.query?.scope || fallback) || fallback;
}

function catalogProductInput(req, fallbackCode = "") {
  const item = safeObj(req.body?.item);
  const code = normText(
    req.body?.code ||
    req.body?.item_code ||
    req.body?.itemCode ||
    item.code ||
    item.item_code ||
    item.itemCode ||
    fallbackCode
  );
  const name = normText(
    req.body?.name ||
    req.body?.description ||
    req.body?.productName ||
    item.name ||
    item.description ||
    item.productName
  );
  return { code, name };
}

async function listCatalogProducts(req, res, fallbackScope = "returns_items") {
  try {
    const scope = catalogScope(req, fallbackScope);
    const limit = clampInt(req.query?.limit, 5000, 1, 10000);

    const { rows } = await pool.query(
      `SELECT scope, code, name, created_at, updated_at
         FROM product_catalog
        WHERE scope = $1
        ORDER BY code ASC
        LIMIT $2`,
      [scope, limit]
    );

    const items = rows.map(catalogRowToClient);
    const map = {};
    for (const item of items) map[String(item.code)] = String(item.name);

    return res.json({ ok: true, scope, count: items.length, items, map });
  } catch (e) {
    console.error("GET catalog products ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

async function upsertCatalogProduct(req, res, fallbackScope = "returns_items") {
  try {
    const scope = catalogScope(req, fallbackScope);
    const { code, name } = catalogProductInput(req);

    if (!code || !name) {
      return res.status(400).json({ ok: false, error: "code & name required" });
    }

    const { rows } = await pool.query(
      `INSERT INTO product_catalog (scope, code, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (scope, code)
       DO UPDATE SET name = EXCLUDED.name, updated_at = now()
       RETURNING scope, code, name, created_at, updated_at`,
      [scope, code, name]
    );

    return res.json({ ok: true, item: catalogRowToClient(rows[0]) });
  } catch (e) {
    console.error("UPSERT catalog products ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

async function updateCatalogProduct(req, res, fallbackScope = "returns_items") {
  let client;
  try {
    client = await pool.connect();
    const scope = catalogScope(req, fallbackScope);
    const oldCode = normText(req.params?.code || req.body?.oldCode || req.body?.old_code);
    const { code, name } = catalogProductInput(req, oldCode);

    if (!oldCode) {
      return res.status(400).json({ ok: false, error: "code param required" });
    }
    if (!code || !name) {
      return res.status(400).json({ ok: false, error: "code & name required" });
    }

    await client.query("BEGIN");

    let result;
    if (oldCode === code) {
      result = await client.query(
        `INSERT INTO product_catalog (scope, code, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (scope, code)
         DO UPDATE SET name = EXCLUDED.name, updated_at = now()
         RETURNING scope, code, name, created_at, updated_at`,
        [scope, code, name]
      );
    } else {
      result = await client.query(
        `UPDATE product_catalog
            SET code = $3, name = $4, updated_at = now()
          WHERE scope = $1 AND code = $2
          RETURNING scope, code, name, created_at, updated_at`,
        [scope, oldCode, code, name]
      );

      if (result.rowCount === 0) {
        result = await client.query(
          `INSERT INTO product_catalog (scope, code, name)
           VALUES ($1, $2, $3)
           RETURNING scope, code, name, created_at, updated_at`,
          [scope, code, name]
        );
      }
    }

    await client.query("COMMIT");
    return res.json({ ok: true, item: catalogRowToClient(result.rows[0]) });
  } catch (e) {
    await rollbackQuietly(client);

    if (e && e.code === "23505") {
      return res.status(409).json({
        ok: false,
        error: "DUPLICATE_CODE",
        message: "This code already exists in this scope.",
      });
    }

    console.error("PUT catalog products ERROR =", e);
    return sendDbError(res, e);
  } finally {
    if (client) client.release();
  }
}

async function deleteCatalogProduct(req, res, fallbackScope = "returns_items") {
  try {
    const scope = catalogScope(req, fallbackScope);
    const code = normText(req.params?.code || req.query?.code || req.body?.code || req.body?.item_code);

    if (!code) {
      return res.status(400).json({ ok: false, error: "code required" });
    }

    const { rows } = await pool.query(
      `DELETE FROM product_catalog
        WHERE scope = $1 AND code = $2
        RETURNING scope, code, name, created_at, updated_at`,
      [scope, code]
    );

    return res.json({
      ok: true,
      deleted: rows.length > 0,
      item: rows[0] ? catalogRowToClient(rows[0]) : null,
    });
  } catch (e) {
    console.error("DELETE catalog products ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

app.get(["/api/catalog/products", "/api/catalog/items", "/api/items"], (req, res) =>
  listCatalogProducts(req, res, "returns_items")
);
app.post(["/api/catalog/products", "/api/catalog/items", "/api/items"], (req, res) =>
  upsertCatalogProduct(req, res, "returns_items")
);
app.put(["/api/catalog/products/:code", "/api/catalog/items/:code", "/api/items/:code"], (req, res) =>
  updateCatalogProduct(req, res, "returns_items")
);
app.delete(["/api/catalog/products/:code", "/api/catalog/items/:code", "/api/items/:code"], (req, res) =>
  deleteCatalogProduct(req, res, "returns_items")
);

app.put("/api/product-catalog/:code", (req, res) => updateCatalogProduct(req, res, "default"));
app.delete("/api/product-catalog/:code", (req, res) => deleteCatalogProduct(req, res, "default"));

app.get("/api/product-catalog", async (req, res) => {
  try {
    const scope = normText(req.query?.scope || "default");
    const limit = clampInt(req.query?.limit, 2000, 1, 5000);

    const { rows } = await pool.query(
      `SELECT scope, code, name, created_at, updated_at
         FROM product_catalog
        WHERE scope = $1
        ORDER BY code ASC
        LIMIT $2`,
      [scope, limit]
    );

    const map = {};
    for (const r of rows) map[String(r.code)] = String(r.name);

    return res.json({ ok: true, scope, count: rows.length, items: rows, map });
  } catch (e) {
    console.error("GET /api/product-catalog ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/product-catalog", async (req, res) => {
  try {
    const scope = normText(req.body?.scope || "default");
    const code = normText(req.body?.code);
    const name = normText(req.body?.name);

    if (!code || !name) {
      return res.status(400).json({ ok: false, error: "code & name required" });
    }

    const { rows } = await pool.query(
      `INSERT INTO product_catalog (scope, code, name)
       VALUES ($1, $2, $3)
       RETURNING scope, code, name, created_at, updated_at`,
      [scope, code, name]
    );

    return res.status(201).json({ ok: true, item: rows[0] });
  } catch (e) {
    console.error("POST /api/product-catalog ERROR =", e);

    if (e && e.code === "23505") {
      return res.status(409).json({
        ok: false,
        error: "DUPLICATE_CODE",
        message: "This code already exists in this scope.",
      });
    }

    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
};
