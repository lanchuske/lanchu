# Lanchu — Arquitectura

> Diseño concreto: **superficies**, **ciclo de vida**, **identidad**, **tools MCP**,
> **recursos**, **roles/gobernanza**, **eventos**. Complementa
> [`DEFINITION.md`](./DEFINITION.md) (el porqué) y
> [`OPEN-QUESTIONS.md`](./OPEN-QUESTIONS.md) (lo aún abierto). Responde: *¿cómo funciona,
> exactamente?*

---

## 1. Las tres superficies

| Superficie | Qué es | Responsabilidad |
|-----------|--------|-----------------|
| **CLI / launcher** (`npx lanchu`) | Lo que corres en la terminal. | Onboarding: empareja el objetivo, hace la pregunta **reutilizar-o-crear** al humano, elige rol, emite el **token de identidad** y mantiene la conexión viva (= presencia). |
| **Servidor MCP** | El servicio compartido al que el agente se conecta (`localhost` HTTP/SSE). | Tools, estado (SQLite), roles/gobernanza, event bus, audit. |
| **Panel web** | Dashboard del supervisor (local, sin auth). | Ver agentes/actividad/audit en tiempo real; retirar agentes con handoff. |

> **Clave:** la pregunta *"¿reutilizar?"* ocurre en la **CLI** (interacción con el
> humano), **no** es una tool MCP. El launcher consulta candidatos y conecta la sesión a
> la identidad durable elegida.

---

## 2. Identidad, sesión y actividad (decisión A4)

- Al arrancar, el launcher **emite un token de sesión** ligado a un `agent_id`. Toda
  llamada MCP viaja con ese token → el servidor sabe **qué agente** es cada conexión (y
  nadie lo suplanta localmente).
- **Presencia (activo/idle):** mientras el launcher está vivo y conectado (SSE abierto),
  el agente está **ACTIVO**. Cuando el launcher termina (cierras la ventana) → **IDLE**.
- **Actividad ("qué hace ahora"):** se **deriva de las tool-calls recientes** (última
  tarea reclamada/actualizada, último doc tocado). **No** depende de que el agente llame
  a un heartbeat. Opcionalmente el agente puede anotar con `session.note`, pero la
  presencia y la actividad no dependen de ello.

---

## 3. Ciclo de vida y agentes durables

### Sesión ≠ Agente
- **Agente** = identidad durable (rol, alcance, tareas, *huella*, historial).
- **Sesión** = una conexión viva atada a un agente vía token. Efímera.

### Estados
```
   crear / reutilizar
        │
        ▼
   ACTIVO ──(launcher termina)──▶ IDLE ──(reabres/reutilizas)──▶ ACTIVO
        │                           │
        └──────── retirar ──────────┘
                     │
        ¿tareas abiertas? ── SÍ ─▶ handoff obligatorio (reasignar/soltar) por tarea
                          └─ NO ─▶ RETIRADO (archivado; permanece en audit)
```
Eventos: `agent.created` · `agent.reused` · `agent.active` · `agent.idle` ·
`agent.retired`.

### Del objetivo a las tareas (decisión A1)
El launcher registra el objetivo y **el agente lo descompone en tareas** con `task.create`
(Lanchu no descompone por él). A partir de ahí hay tareas concretas sobre las que
coordinar y aplicar límites.

### La huella (reutilizar por objetivo)
Cada agente acumula una **huella**: tareas hechas, etiquetas/áreas tocadas, contexto.
Al arrancar con un objetivo, Lanchu compara contra las huellas de los agentes `idle` y
devuelve **candidatos** ordenados por solape. *(Mecanismo de emparejamiento del v0: solape
de etiquetas/keywords; ver [`OPEN-QUESTIONS.md`](./OPEN-QUESTIONS.md).)*

### Retiro seguro
Retirar con tareas abiertas **está bloqueado** hasta resolver cada una: `task.reassign` a
otro agente o `task.release` al pool. Al final, `agent.retired`. Nada huérfano.

---

## 4. Roles y gobernanza (decisiones A2, A3)

### Modelo de roles
- **Rol** = `{ nombre, allowed_tags: [...] }`, definido por la org (custom). Un rol `*`
  puede tocar todo (coordinador).
- **Tarea** lleva `tags: [...]`.
- **Regla de alcance:** un agente con rol *R* puede **reclamar o crear** una tarea *T*
  si `T.tags ⊆ R.allowed_tags`. Si no, la acción se **rechaza** (error) + evento
  `scope.violation`.

### Qué puede y qué no puede hacer Lanchu (honestidad)
Cada tool que **muta** estado pasa por dos pasos:
1. **Chequeo de alcance** contra el rol y las reglas de la org → si viola, **error**.
2. **Registro en audit** de la acción (aplicada *o* rechazada), con actor, sujeto,
   workspace y coste/tokens **si el agente los reporta** (autoreportado; Lanchu no mide).

**Alcance real del enforcement:** el bloqueo es duro **solo sobre acciones mediadas por
Lanchu** (reclamar/crear tareas, escribir docs). Lanchu **no es un sandbox del SO**: no
puede impedir que un agente edite archivos o corra comandos por su cuenta. El carril es
**cooperativo + auditable**; la confianza viene de que **todo queda visible y registrado**.
Enforcement a nivel de SO es **no-goal**.

---

## 5. Recursos MCP (suscribibles, solo lectura)

| URI | Contenido | Se actualiza cuando… |
|-----|-----------|----------------------|
| `lanchu://board` | Agentes (estado), actividad, tareas. | cualquier `agent.*` / `task.*`. |
| `lanchu://agents` | Agentes durables de la org y su estado. | cambia el ciclo de vida. |
| `lanchu://tasks/mine` | Tareas del agente. | cambia una tarea suya. |
| `lanchu://tasks/available` | Tareas cuyo `tags ⊆ allowed_tags` del rol. | se crea/libera/reclama una tarea. |
| `lanchu://task/{id}` | Detalle + dependencias + dueño. | esa tarea cambia. |
| `lanchu://org/roles` | Roles de la org y sus `allowed_tags`. | el supervisor los edita. |
| `lanchu://docs/{id}` | Un documento compartido. | ese doc se actualiza. |
| `lanchu://me` | Identidad, rol, alcance y huella del agente. | cambian. |
| `lanchu://audit` | Registro inmutable de actividad. | ocurre cualquier evento. |

Notificaciones = MCP nativas (`resources/updated`) con polling (`board.snapshot`) de
respaldo.

---

## 6. Tools de los agentes (MCP)

### `session.*`
| Tool | Entradas | Notas |
|------|----------|-------|
| `session.whoami` | — | Identidad + rol + `allowed_tags` + huella. |
| `session.note` | `text` | Anota actividad (opcional). La presencia **no** depende de esto. |
| `session.leave` | — | La sesión termina; el agente pasa a **IDLE**. Emite `agent.idle`. |

> No hay `session.register`/`heartbeat`: la identidad la emite el **launcher** (§2) y la
> presencia se deriva de la conexión viva.

### `task.*` — coordinación + límites
| Tool | Entradas | Notas |
|------|----------|-------|
| `task.list` | `filter` | Vista *pull*. |
| `task.get` | `id` | Detalle + dueño. |
| `task.create` | `title`, `tags`, `deps?` | El agente estructura su plan. Rechazada si `tags ⊄ allowed_tags`. Emite `task.created`. |
| `task.check_scope` | `id` | `yours` / `someone_else` / `out_of_role`. |
| `task.claim` | `id`, `workspace?` | **Lock atómico** + chequeo de rol. Falla si tomada o fuera de rol. Emite `task.claimed`. |
| `task.update` | `id`, `status`, `note?` | `done` desbloquea dependientes. Emite `task.started/blocked/completed`. |
| `task.release` | `id` | Vuelve al pool. Emite `task.released`. |
| `task.reassign` | `id`, `to_agent` | Handoff (usado en retiro seguro). Emite `task.reassigned`. |
| `task.handoff` | `id`, `note` | Handoff explícito con nota, enrutado por Lanchu (logueado). Emite `task.handoff`. |

> `workspace` es genérico (una rama de git es un caso; también puede ser una carpeta, un
> tablero externo, etc.). No atamos Lanchu a git.

### `doc.*` — documentación viva (mínima en v0)
| Tool | Entradas | Notas |
|------|----------|-------|
| `doc.list` / `doc.search` | `query?` | — |
| `doc.read` | `id` | Las tools empujan a leer antes de actuar. |
| `doc.update` / `doc.create` | `id?`, `content` | Controlado por rol. Emite `doc.updated`. |

### `org.*` / `board.*`
| Tool | Notas |
|------|-------|
| `org.roles` | Roles de la org y sus `allowed_tags`. |
| `org.context` | Contexto mínimo por rol/tarea (optimiza tokens). |
| `board.snapshot` | Respaldo *pull* para clientes sin suscripciones. |

---

## 7. Eventos

```
agent.created   agent.reused   agent.active   agent.idle   agent.retired
task.created    task.claimed   task.released  task.started
task.completed  task.blocked   task.reassigned  task.handoff
doc.created     doc.updated
scope.violation
```

**Forma de un evento:**
```json
{
  "type": "task.completed",
  "org": "acme", "project": "landing",
  "actor": { "agent": "arregla-login", "role": "frontend" },
  "subject": { "kind": "task", "id": "task-42" },
  "data": { "workspace": "feat/login", "note": "Login listo", "tokens": 18240 },
  "timestamp": "2026-07-09T14:30:00Z"
}
```
`tokens` es opcional/autoreportado. Los eventos alimentan panel, notificaciones MCP y
audit log.

---

## 8. Fuera del v0 (roadmap)

- **Webhooks** (salientes con firma HMAC; entrantes para tareas/funciones recurrentes).
- **Backend remoto**, **funciones recurrentes**, **skills**, **límites avanzados** (§10
  de la definición). Documentados para no cerrar la puerta; **no** entran en el v0.

---

## 9. Cómo se resuelve cada pilar (mapa a la definición)

| Pilar (DEFINITION.md §3) | Mecanismo aquí |
|--------------------------|----------------|
| **1. Onboarding sin fricción** | CLI/launcher (§1) + identidad por token (§2). |
| **2. Agentes durables** | Ciclo de vida + huella (§3); reutilizar-o-crear; retiro seguro con `task.reassign`/`task.release`. |
| **3. Carril + visibilidad** | Roles con etiquetas + chequeo de alcance (§4); `task.claim` (lock); `lanchu://audit` + panel; `doc.*` mínimo. |
