# Lanchu — Arquitectura de coordinación

> Diseño concreto de la superficie MCP: **tools**, **recursos**, **eventos** y
> **webhooks**. Complementa [`DEFINITION.md`](./DEFINITION.md), que cubre el problema y
> el alcance. Este documento responde: *¿cómo se coordinan los agentes, exactamente?*

---

## 1. Modelo de coordinación

Hay **un único event bus** dentro de Lanchu. Cada acción de un agente (reclamar tarea,
completar, actualizar doc…) muta el estado y **emite un evento**. Ese mismo stream de
eventos alimenta a **tres consumidores**:

```
                          ┌─────────────────────────┐
   Agentes (MCP tools) ──▶│      Lanchu core        │
                          │  estado (SQLite)        │
                          │  + event bus            │
                          └───────────┬─────────────┘
                                      │  cada acción emite un evento
                    ┌─────────────────┼──────────────────────┐
                    ▼                 ▼                      ▼
            1) Dashboard        2) Notificaciones MCP    3) Webhooks
             (SSE al navegador)   (resource.updated →     (POST → sistemas
                                   el cliente re-lee)       externos)
```

- **Empujar cambios:** el agente llama tools (`task.claim`, `task.update`…).
- **Recibir coordinación:** el agente se **suscribe a recursos MCP**; cuando algo
  relevante cambia, Lanchu envía `notifications/resources/updated` y el cliente re-lee
  el recurso. Para clientes sin soporte de suscripción, existe el respaldo *pull*
  (`board.snapshot`, `task.list`).
- **Coordinar con el exterior:** los **webhooks** conectan el event bus con sistemas
  externos (Slack, CI, GitHub) en ambas direcciones.

### Decisiones de diseño fijadas

- **Control de alcance = bloqueo duro.** Si un agente intenta reclamar una tarea que
  está tomada o fuera de su rol, la tool **falla con error**; no puede continuar.
- **Notificaciones = MCP nativas.** Se usan *resource subscriptions* del protocolo MCP.
  Polling queda solo como respaldo.

---

## 2. Recursos MCP (lo que el agente observa)

Los recursos son de **solo lectura** y **suscribibles**. Representan la "verdad" que el
agente necesita ver en vivo.

| URI del recurso | Contenido | Se actualiza cuando… |
|-----------------|-----------|----------------------|
| `lanchu://board` | Estado del tablero: agentes activos, ramas, tareas. | cualquier `agent.*` o `task.*`. |
| `lanchu://tasks/mine` | Tareas asignadas/reclamadas por este agente. | cambia una tarea suya. |
| `lanchu://tasks/available` | Tareas disponibles para su rol. | se crea/libera/reclama una tarea. |
| `lanchu://task/{id}` | Detalle de una tarea + dependencias. | esa tarea cambia. |
| `lanchu://org/rules` | Reglas/políticas de la org. | el humano actualiza reglas. |
| `lanchu://docs/{id}` | Un documento compartido. | ese doc se actualiza. |
| `lanchu://me` | Identidad, rol y alcance del agente. | cambia su rol/alcance. |

**Flujo típico:** el agente se suscribe a `lanchu://tasks/mine`. Cuando su dependencia
termina, Lanchu emite `task.completed`, marca la tarea suya como desbloqueada, y envía
`notifications/resources/updated` para `lanchu://tasks/mine`. El agente re-lee y actúa.

---

## 3. Tools de los agentes

### `session.*` — identidad y presencia
| Tool | Entradas clave | Devuelve | Notas |
|------|----------------|----------|-------|
| `session.register` | `org`, `project`, `role` | identidad, alcance, contexto mínimo | Punto de entrada. Emite `agent.registered`. |
| `session.whoami` | — | identidad + rol + alcance | El agente recuerda quién es. |
| `session.heartbeat` | `branch`, `activity` | ok | Alimenta el tablero. Emite `agent.heartbeat`. |
| `session.leave` | — | ok | Libera tareas reclamadas. Emite `agent.left`. |

### `task.*` — trabajo y control de alcance
| Tool | Entradas clave | Devuelve | Notas |
|------|----------------|----------|-------|
| `task.list` | `filter` (`mine`/`available`/`status`) | lista de tareas | Vista *pull*. |
| `task.next` | — | la tarea que le toca ahora | Tool de **foco**. |
| `task.get` | `id` | detalle + dependencias + dueño | — |
| `task.check_scope` | `id` | `yours` / `someone_else` / `out_of_role` | Consulta antes de actuar. |
| `task.claim` | `id`, `branch?` | tarea reclamada **o ERROR** | **Bloqueo duro**: falla si está tomada o fuera de rol. Emite `task.claimed`. |
| `task.update` | `id`, `status`, `note?`, `branch?` | tarea actualizada | `done` **desbloquea dependientes**. Emite `task.started/blocked/completed`. |
| `task.release` | `id` | ok | Otro agente puede tomarla. Emite `task.released`. |
| `task.create` | `title`, `role?`, `deps?` | tarea creada | Según permisos del rol. |
| `task.assign` | `id`, `agent` | ok | Solo rol coordinador. Emite `task.assigned`. |

### `doc.*` — documentación viva
| Tool | Entradas clave | Devuelve | Notas |
|------|----------------|----------|-------|
| `doc.list` / `doc.search` | `query?` | docs | — |
| `doc.read` | `id` | contenido | Las tools empujan a leer antes de actuar. |
| `doc.update` / `doc.create` | `id?`, `content` | doc | Controlado por rol. Emite `doc.updated`. Mantiene la doc al día. |

### `org.*` — reglas y contexto
| Tool | Devuelve | Notas |
|------|----------|-------|
| `org.rules` | reglas/políticas a cumplir | — |
| `org.context` | contexto mínimo para rol/tarea | Optimiza tokens. |

### `board.*` — respaldo *pull*
| Tool | Devuelve | Notas |
|------|----------|-------|
| `board.snapshot` | estado completo del tablero | Fallback para clientes sin suscripciones. |

---

## 4. Eventos

Vocabulario común que produce el event bus:

```
agent.registered   agent.heartbeat    agent.left
task.created       task.claimed       task.released     task.started
task.completed     task.blocked       task.assigned
doc.created        doc.updated
scope.violation    branch.changed
```

**Forma de un evento:**
```json
{
  "type": "task.completed",
  "org": "acme",
  "project": "landing",
  "actor": { "agent": "agent-7", "role": "frontend" },
  "subject": { "kind": "task", "id": "task-42" },
  "data": { "branch": "feat/hero", "note": "Hero listo" },
  "timestamp": "2026-07-09T14:30:00Z"
}
```

Los eventos son la fuente de: (1) las actualizaciones del dashboard, (2) las
notificaciones MCP `resources/updated`, y (3) los webhooks salientes.

---

## 5. Webhooks

### 5.1 Salientes (Lanchu → exterior)
Registras una URL y Lanchu hace `POST` cuando ocurren eventos que te interesan.

**Config:**
```json
{
  "url": "https://hooks.example.com/lanchu",
  "events": ["task.completed", "scope.violation"],
  "org": "acme",
  "project": "landing",
  "secret": "whsec_..."
}
```
- `events`: filtro (o `*` para todos).
- `secret`: se firma el body con **HMAC-SHA256** en la cabecera `X-Lanchu-Signature`
  para que el receptor verifique autenticidad.
- Entrega **at-least-once** con reintentos y backoff.

**Casos de uso:** avisar a Slack/Discord al completar una tarea; disparar CI/CD al tocar
una rama; alertar al humano ante `scope.violation`; volcar eventos a un dashboard o hoja
de cálculo externa.

### 5.2 Entrantes (exterior → Lanchu)
Una URL de Lanchu que otros sistemas llaman para disparar acciones.

- `POST /hooks/github` — un `push` crea/avanza una tarea.
- `POST /hooks/schedule` — un scheduler dispara una **función recurrente** (arranca una
  sesión). *(Función recurrente = roadmap.)*
- `POST /hooks/intake` — un formulario o email entrante crea una tarea.

Los webhooks entrantes se autentican por firma/token y respetan las reglas de la org.

---

## 6. Cómo se resuelve cada desafío (mapa a la definición)

| Desafío (DEFINITION.md §3) | Mecanismo aquí |
|----------------------------|----------------|
| Identidad y registro | `session.register` + recurso `lanchu://me` |
| Alcance y roles | Bloqueo duro en `task.claim` + `task.check_scope` |
| Asignación de tareas | `task.*` + `task.assign` (coordinador) |
| Estado compartido en vivo | Recursos MCP + notificaciones `resources/updated` |
| Documentación viva | `doc.*` + evento `doc.updated` |
| Foco y eficiencia | `task.next` + `org.context` |
| Trazabilidad | Event bus → audit log → dashboard |
| Recurrencia | Webhook entrante `POST /hooks/schedule` (roadmap) |
| Simplicidad | Un proceso local; `npx lanchu` levanta todo |
