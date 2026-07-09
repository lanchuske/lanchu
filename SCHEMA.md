# Lanchu — Esquema de datos (SQLite)

> Modelo de datos del v0. Concreta [`ARCHITECTURE.md`](./ARCHITECTURE.md) en tablas,
> campos y estados. SQLite estándar (compatible con `node:sqlite`); JSON como `TEXT` con
> las funciones `json1`. Todas las marcas de tiempo son ISO-8601 UTC (`TEXT`). Los `id`
> son cadenas generadas por la app salvo donde se indique.

---

## 1. Vista general (entidades y relaciones)

```
org ─┬─ role ──< role_tag
     ├─ agent ──< session
     │     └── (owner) ──< task
     ├─ project ──< task ──< task_tag
     │                └──< task_dep
     ├─ doc
     └─ event   (append-only: audit log + stream de eventos)
```

- **org** contiene todo lo demás. Puede haber varias en la misma máquina.
- **role** = nombre + etiquetas permitidas (vía `role_tag`) o comodín.
- **agent** = miembro durable (activo/idle/retirado), con un rol.
- **session** = conexión viva atada a un agente (efímera; identidad por token).
- **project** agrupa **task**s; cada tarea lleva **task_tag**s y **task_dep**endencias.
- **doc** = documentación compartida de la org.
- **event** = registro inmutable; es a la vez audit log y fuente del stream.

---

## 2. DDL

```sql
PRAGMA journal_mode = WAL;      -- lectura concurrente; un solo escritor (el servidor)
PRAGMA foreign_keys = ON;

CREATE TABLE schema_meta (
  version     INTEGER NOT NULL
);
-- INSERT INTO schema_meta(version) VALUES (1);

CREATE TABLE org (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

CREATE TABLE project (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (org_id, name)
);

CREATE TABLE role (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  is_wildcard INTEGER NOT NULL DEFAULT 0,   -- 1 = puede tocar cualquier etiqueta ('*')
  created_at  TEXT NOT NULL,
  UNIQUE (org_id, name)
);

CREATE TABLE role_tag (
  role_id     TEXT NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,
  PRIMARY KEY (role_id, tag)
);

CREATE TABLE agent (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  role_id           TEXT NOT NULL REFERENCES role(id),
  name              TEXT NOT NULL,            -- display, único por org (ej. 'arregla-login')
  objective         TEXT,                     -- objetivo con que se creó (para reuse + panel)
  state             TEXT NOT NULL DEFAULT 'active'
                      CHECK (state IN ('active','idle','retired')),
  last_activity_at  TEXT,                     -- derivado de la última tool-call (panel)
  last_activity     TEXT,                     -- resumen corto de esa acción
  created_at        TEXT NOT NULL,
  retired_at        TEXT,
  UNIQUE (org_id, name)
);

CREATE TABLE session (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,           -- emitido por el launcher; identifica la conexión
  client      TEXT,                           -- ej. 'claude-code', 'cursor'
  started_at  TEXT NOT NULL,
  ended_at    TEXT                            -- NULL = viva → agente ACTIVO
);

CREATE TABLE task (
  id                  TEXT PRIMARY KEY,        -- ej. 'task-42'
  project_id          TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  parent_task_id      TEXT REFERENCES task(id),-- NULL = raíz (suele ser el objetivo)
  title               TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available','claimed','in_progress','blocked','done')),
  owner_agent_id      TEXT REFERENCES agent(id),-- NULL sii status='available'
  workspace           TEXT,                    -- genérico: rama git, carpeta, tablero… (opcional)
  created_by_agent_id TEXT REFERENCES agent(id),
  created_at          TEXT NOT NULL,
  claimed_at          TEXT,                    -- para detectar 'stale' (idle zombie)
  updated_at          TEXT NOT NULL,
  done_at             TEXT
);

CREATE TABLE task_tag (
  task_id     TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,
  PRIMARY KEY (task_id, tag)
);

CREATE TABLE task_dep (
  task_id            TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE TABLE doc (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  content             TEXT NOT NULL DEFAULT '',
  updated_at          TEXT NOT NULL,
  updated_by_agent_id TEXT REFERENCES agent(id),
  created_at          TEXT NOT NULL
);

-- Append-only. Es el audit log y la fuente del stream de eventos.
CREATE TABLE event (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,  -- orden monótono del stream
  org_id         TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  project_id     TEXT REFERENCES project(id) ON DELETE SET NULL,
  type           TEXT NOT NULL,                       -- ver §3
  actor_agent_id TEXT REFERENCES agent(id),
  subject_kind   TEXT,                                -- 'task' | 'doc' | 'agent'
  subject_id     TEXT,
  workspace      TEXT,
  tokens         INTEGER,                             -- autoreportado; puede ser NULL
  outcome        TEXT NOT NULL DEFAULT 'applied'
                   CHECK (outcome IN ('applied','rejected')),  -- 'rejected' = scope.violation
  data           TEXT,                                -- JSON extra
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_task_project_status ON task(project_id, status);
CREATE INDEX idx_task_owner          ON task(owner_agent_id);
CREATE INDEX idx_task_tag_tag        ON task_tag(tag);
CREATE INDEX idx_role_tag_tag        ON role_tag(tag);
CREATE INDEX idx_agent_org_state     ON agent(org_id, state);
CREATE INDEX idx_session_agent_live  ON session(agent_id, ended_at);
CREATE INDEX idx_event_org_id        ON event(org_id, id);
CREATE INDEX idx_event_actor         ON event(actor_agent_id, id);
```

---

## 3. Enumeraciones

- **agent.state:** `active` · `idle` · `retired`.
- **task.status:** `available` · `claimed` · `in_progress` · `blocked` · `done`.
  Invariante: `status='available'` ⟺ `owner_agent_id IS NULL`.
  "Reservada" (idle) **no** es un estado: es una tarea `claimed`/`in_progress` cuyo dueño
  está `idle`.
- **event.type:** `agent.created` · `agent.reused` · `agent.active` · `agent.idle` ·
  `agent.retired` · `task.created` · `task.claimed` · `task.released` · `task.started` ·
  `task.completed` · `task.blocked` · `task.reassigned` · `task.handoff` ·
  `doc.created` · `doc.updated` · `scope.violation`.
- **event.outcome:** `applied` (se aplicó) · `rejected` (se bloqueó; p.ej. `scope.violation`).

---

## 4. Operaciones clave (cómo el esquema hace real cada decisión)

### 4.1 Claim atómico + chequeo de alcance (A2)
En una transacción `BEGIN IMMEDIATE` (un solo escritor con WAL):
```sql
-- 1) ¿El rol del agente cubre TODAS las etiquetas de la tarea?  (o es comodín)
--    Rechaza si existe alguna task_tag fuera de las allowed del rol.
SELECT 1
FROM task t
JOIN agent a   ON a.id = :agent_id
JOIN role  r   ON r.id = a.role_id
WHERE t.id = :task_id
  AND ( r.is_wildcard = 1
        OR NOT EXISTS (
          SELECT 1 FROM task_tag tt
          WHERE tt.task_id = t.id
            AND tt.tag NOT IN (SELECT tag FROM role_tag WHERE role_id = r.id)
        ) );
-- si no devuelve fila → RECHAZO: emitir event(type='scope.violation', outcome='rejected')

-- 2) Lock atómico: solo prospera si sigue disponible.
UPDATE task
SET status='claimed', owner_agent_id=:agent_id, claimed_at=:now, updated_at=:now
WHERE id=:task_id AND status='available';
-- changes() debe ser 1; si es 0 → ya estaba tomada (otro ganó la carrera).
```
`task.create` aplica el **mismo** chequeo de alcance del paso 1 sobre las `tags` que se
quieren poner.

### 4.2 Presencia y actividad (A4)
- **Activo:** `EXISTS (SELECT 1 FROM session WHERE agent_id=? AND ended_at IS NULL)`.
- **Idle:** el agente no tiene sesión viva y no está retirado.
- **Actividad ("qué hace ahora"):** cada tool-call que muta estado actualiza
  `agent.last_activity_at` / `last_activity` y escribe un `event`. El panel lee eso; no
  hay heartbeat del agente.

### 4.3 Reutilizar por objetivo (A1 / huella)
Dado un objetivo nuevo, buscar agentes `idle` de la org cuya **huella** solape:
```sql
-- Huella = agent.objective + títulos/etiquetas de sus tareas.
-- v0: solape de keywords/etiquetas, ranking por nº de coincidencias.
-- (El emparejamiento fino queda como detalle de implementación; ver OPEN-QUESTIONS.)
```
Se ofrecen los candidatos ordenados; la elección la hace el humano en la **CLI**.

### 4.4 Desbloqueo por dependencias
Al pasar una tarea a `done`, revisar las que dependían de ella:
```sql
-- una tarea 'blocked' puede volver a 'available' si YA no le quedan deps sin 'done'
UPDATE task SET status='available', updated_at=:now
WHERE status='blocked'
  AND NOT EXISTS (
    SELECT 1 FROM task_dep d JOIN task p ON p.id = d.depends_on_task_id
    WHERE d.task_id = task.id AND p.status <> 'done' );
```

### 4.5 Retiro seguro (handoff)
```sql
-- BLOQUEA si hay tareas abiertas del agente:
SELECT COUNT(*) FROM task
WHERE owner_agent_id=:agent_id AND status IN ('claimed','in_progress','blocked');
-- si > 0 → exigir por cada una: task.reassign (owner→otro) o task.release (→available)
-- solo entonces:
UPDATE agent SET state='retired', retired_at=:now WHERE id=:agent_id;
UPDATE session SET ended_at=:now WHERE agent_id=:agent_id AND ended_at IS NULL;
```

---

## 5. Detalles que este esquema deja listos (o señala)

- **Idle "zombie" (C4):** dos señales **derivadas** (no columnas nuevas):
  - *reservada* = `owner_agent_id` no nulo y su `agent.state='idle'`.
  - *stale* = reservada **y** `updated_at` más viejo que `LANCHU_STALE_HOURS` (def. 24h).

  **v0: no auto-liberar.** El panel/`lanchu tasks` las marcan; el supervisor usa
  `task release`/`task reassign` (override). Esos overrides se auditan con
  `event.data.override = true` (actor = supervisor, no el dueño).
- **Multi-org/proyecto:** el esquema soporta varias orgs y proyectos. **Cómo elige el
  launcher la org/proyecto y el rol de un agente nuevo** sigue abierto (C2/C3).
- **Docs siempre al día (C5):** hay `doc` + trazabilidad vía `event`. El *mecanismo* de
  "empujar a actualizar" (nudge al cerrar tarea) es de comportamiento, no de esquema.
- **Coste/tokens:** `event.tokens` es **autoreportado** y puede ser `NULL`.
- **Migraciones:** `schema_meta.version` para versionar el esquema entre releases.

---

## 6. Pendientes ligados al esquema (ver OPEN-QUESTIONS.md)

- **C2** — comandos CLI y selección de org/proyecto/rol al lanzar.
- **C3** — cómo se inyecta la URL/token del servidor MCP en el cliente del agente.
- **C4** — umbral y UX de tareas *stale*.
- **C5** — nudge de documentación.
