# Lanchu — Arquitectura

> Diseño concreto: **superficies**, **ciclo de vida de agentes**, **tools MCP**,
> **recursos**, **eventos**, **gobernanza** y **webhooks**. Complementa
> [`DEFINITION.md`](./DEFINITION.md), que cubre el problema, el foco y el porqué. Este
> documento responde: *¿cómo funciona, exactamente?*

---

## 1. Las tres superficies

Lanchu se toca por tres lados. Distinguirlos importa —sobre todo para saber **dónde vive
el "¿reutilizar?"**:

| Superficie | Qué es | Responsabilidad |
|-----------|--------|-----------------|
| **CLI / launcher** (`npx lanchu`) | Lo que corres en la terminal. | Onboarding: empareja el objetivo, hace la pregunta **reutilizar-o-crear** al humano, y arranca el agente conectado a Lanchu con una identidad durable. |
| **Servidor MCP** | El servicio compartido al que el agente se conecta. | Las tools que el agente usa mientras trabaja; estado, gobernanza, event bus. |
| **Panel web** | Dashboard del supervisor. | Ver agentes, actividad y audit en tiempo real; retirar agentes con handoff. |

> **Clave:** la pregunta *"¿reutilizar el agente que ya tocó login?"* ocurre en la **CLI**
> (interacción con el humano), **no** es una tool MCP. Un agente no interrumpe al humano;
> el launcher sí. El launcher consulta a Lanchu los candidatos y decide a qué identidad
> durable conectar la sesión.

---

## 2. Ciclo de vida y agentes durables

### Sesión ≠ Agente
- **Agente** = identidad durable (rol, alcance, tareas, *huella*, historial). Vive en la
  org.
- **Sesión** = una conexión viva (una ventana de terminal) atada a un agente. Efímera.

### Estados del agente
```
   crear/reutilizar
        │
        ▼
   ACTIVO ──(cierras la ventana)──▶ IDLE ──(reabres/reutilizas)──▶ ACTIVO
        │                             │
        └──────── retirar ───────────┘
                     │
                     ▼
   ¿tareas abiertas? ── SÍ ─▶ handoff obligatorio (reasignar / soltar) por tarea
                     └─ NO ─▶ RETIRADO (archivado; permanece en audit)
```

- **ACTIVO**: sesión viva, trabajando. Emite `agent.heartbeat`.
- **IDLE**: sin sesión, pero vivo; conserva rol, tareas reservadas y contexto. Emite
  `agent.idle`.
- **RETIRADO**: archivado tras resolver sus tareas. Emite `agent.retired`.

### La huella (para reutilizar por objetivo)
Cada agente acumula una **huella**: tareas que hizo, áreas/etiquetas que tocó, contexto.
Cuando el launcher arranca con un objetivo, Lanchu compara ese objetivo contra las
huellas de los agentes `idle` y devuelve **candidatos a reutilizar** (ordenados por
solape). Reutilizar = recuperar contexto (menos tokens) y no duplicar.

### Retiro seguro
Retirar un agente con tareas abiertas **está bloqueado** hasta resolver cada una:
reasignar a otro agente (`task.reassign`) o soltar al pool (`task.release`). Emite
`task.reassigned` / `task.released` y, al final, `agent.retired`. Nada huérfano.

---

## 3. Modelo de coordinación (mediada + gobernada)

Todo pasa por Lanchu. Los agentes **no se hablan entre sí**; se coordinan a través del
**estado compartido** (*blackboard*). Cada acción muta el estado y **emite un evento**,
que alimenta a **tres consumidores**:

```
                          ┌─────────────────────────┐
   Agentes (MCP tools) ──▶│      Lanchu core        │
                          │  estado (SQLite)        │
                          │  + reglas/límites        │
                          │  + audit log            │
                          │  + event bus            │
                          └───────────┬─────────────┘
                    ┌─────────────────┼──────────────────────┐
                    ▼                 ▼                      ▼
            1) Panel (SSE)      2) Notificaciones MCP    3) Webhooks (roadmap)
                                 (resource.updated)       (POST → externos)
```

**Decisiones fijadas:** coordinación mediada (no peer-to-peer); alcance = **bloqueo
duro**; protocolo = **MCP** (no A2A, ver [`DEFINITION.md` §7](./DEFINITION.md#7-la-solución));
notificaciones = MCP nativas (resource subscriptions) con polling de respaldo.

---

## 4. Recursos MCP (lo que agentes y supervisor observan)

Solo lectura y **suscribibles**.

| URI | Contenido | Se actualiza cuando… |
|-----|-----------|----------------------|
| `lanchu://board` | Agentes (estado), actividad, tareas. | cualquier `agent.*` / `task.*`. |
| `lanchu://agents` | Agentes durables de la org y su estado. | cambia el ciclo de vida de un agente. |
| `lanchu://tasks/mine` | Tareas del agente. | cambia una tarea suya. |
| `lanchu://tasks/available` | Tareas disponibles para su rol. | se crea/libera/reclama una tarea. |
| `lanchu://task/{id}` | Detalle + dependencias + dueño. | esa tarea cambia. |
| `lanchu://org/rules` | Reglas/políticas (los límites). | el supervisor las actualiza. |
| `lanchu://docs/{id}` | Un documento compartido. | ese doc se actualiza. |
| `lanchu://me` | Identidad, rol, alcance y huella del agente. | cambian. |
| `lanchu://audit` | Registro inmutable de actividad. | ocurre cualquier evento. |

---

## 5. Tools de los agentes (MCP)

### `session.*` — identidad y presencia
| Tool | Entradas | Devuelve | Notas |
|------|----------|----------|-------|
| `session.whoami` | — | identidad + rol + alcance + huella | El agente recuerda quién es. |
| `session.heartbeat` | `activity`, `branch?` | ok | Alimenta el panel. Emite `agent.heartbeat`. |
| `session.leave` | — | ok | La sesión termina; el agente pasa a **IDLE** (no se borra). Emite `agent.idle`. |

> El registro/reutilización lo maneja el **launcher** antes de que arranquen las tools
> (ver §1), así que no hay un `session.register` que el agente decida por su cuenta.

### `task.*` — coordinación mediada + límites
| Tool | Entradas | Devuelve | Notas |
|------|----------|----------|-------|
| `task.list` | `filter` | lista | Vista *pull*. |
| `task.get` | `id` | detalle + dueño | — |
| `task.check_scope` | `id` | `yours`/`someone_else`/`out_of_role` | Consulta antes de actuar. |
| `task.claim` | `id`, `branch?` | tarea **o ERROR** | **Bloqueo duro** + lock atómico. Emite `task.claimed`. |
| `task.update` | `id`, `status`, `note?` | tarea | `done` desbloquea dependientes. Emite `task.started/blocked/completed`. |
| `task.release` | `id` | ok | Vuelve al pool. Emite `task.released`. |
| `task.reassign` | `id`, `to_agent` | ok | Handoff (usado también en retiro seguro). Emite `task.reassigned`. |
| `task.create` | `title`, `role?`, `deps?` | tarea | Según permisos del rol. |
| `task.handoff` | `id`, `note` | ok | Handoff explícito con nota, enrutado por Lanchu (logueado). Emite `task.handoff`. |

> **No** hay tool de "decidir el plan" (decomposición automática, "siguiente tarea" como
> cerebro). Lanchu es desopinado sobre el plan.

### `doc.*` — documentación viva (mínima en v0)
| Tool | Entradas | Notas |
|------|----------|-------|
| `doc.list` / `doc.search` | `query?` | — |
| `doc.read` | `id` | Las tools empujan a leer antes de actuar. |
| `doc.update` / `doc.create` | `id?`, `content` | Controlado por rol. Emite `doc.updated`. |

### `org.*` / `board.*`
| Tool | Notas |
|------|-------|
| `org.rules` | Reglas/políticas a cumplir. |
| `org.context` | Contexto mínimo por rol/tarea (optimiza tokens). |
| `board.snapshot` | Respaldo *pull* para clientes sin suscripciones. |

---

## 6. Gobernanza (cómo se aplican los límites)

Cada tool que **muta** estado pasa por dos pasos antes de aplicarse:

1. **Chequeo de alcance/reglas.** Se evalúa contra el `role` del agente y las `rules` de
   la org. Si viola el alcance → **error** (bloqueo duro) + evento `scope.violation`.
2. **Registro en audit.** Toda acción aplicada (y todo intento bloqueado) queda en
   `lanchu://audit` con actor, acción, sujeto, rama y coste/tokens si están disponibles.

**Qué define un rol (el alcance):** qué tareas puede reclamar, qué docs puede leer/escribir,
qué tools puede usar. (Roadmap: presupuesto de tokens/coste y cuotas.)

El supervisor ve todo en el panel y en `lanchu://audit`. **Confiar = ver + poder acotar.**

---

## 7. Eventos

```
agent.registered   agent.heartbeat   agent.idle   agent.reused   agent.retired
task.created   task.claimed   task.released   task.started
task.completed   task.blocked   task.reassigned   task.handoff
doc.created   doc.updated
scope.violation   branch.changed
```

**Forma de un evento:**
```json
{
  "type": "task.completed",
  "org": "acme", "project": "landing",
  "actor": { "agent": "arregla-login", "role": "frontend" },
  "subject": { "kind": "task", "id": "task-42" },
  "data": { "branch": "feat/login", "note": "Login listo", "tokens": 18240 },
  "timestamp": "2026-07-09T14:30:00Z"
}
```

Los eventos alimentan el panel, las notificaciones MCP y el audit log. (Los webhooks
consumen este mismo stream, pero son roadmap.)

---

## 8. Webhooks (roadmap — fuera del v0)

Se documentan aquí para no cerrar la puerta, pero **no entran en el v0**.

- **Salientes** (Lanchu → exterior): `POST` firmado con **HMAC-SHA256** ante eventos
  filtrados. Casos: alertar al supervisor ante `scope.violation`, avisar a Slack, CI/CD.
- **Entrantes** (exterior → Lanchu): `POST /hooks/…` para crear/avanzar tareas o disparar
  funciones recurrentes; pasan por el mismo chequeo de gobernanza.

---

## 9. Cómo se resuelve cada pilar (mapa a la definición)

| Pilar (DEFINITION.md §3) | Mecanismo aquí |
|--------------------------|----------------|
| **1. Onboarding sin fricción** | CLI/launcher (§1): un comando empareja objetivo y conecta al agente. |
| **2. Agentes durables** | Ciclo de vida + huella (§2); reutilizar-o-crear en el launcher; retiro seguro con `task.reassign`/`task.release`. |
| **3. Carril + visibilidad** | Coordinación mediada + `task.claim` (lock); gobernanza + bloqueo duro (§6); `lanchu://audit` + panel; `doc.*` mínimo. |
