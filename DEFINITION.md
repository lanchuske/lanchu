# Lanchu — Definición del proyecto

> Documento de definición. Describe **qué problema resuelve Lanchu, cuáles son los
> desafíos y cuál es la solución propuesta**. Es la base sobre la que se construye
> el resto del proyecto. Vive versionado en el repo y se actualiza a medida que el
> diseño evoluciona.

---

## 1. Visión

**Lanchu es un servidor MCP liviano y open source que convierte cualquier sesión de
agente (una terminal, Claude Code, Cursor, un agente propio…) en un miembro
coordinado de una organización.**

Al abrir la sesión, el agente **se registra en una organización, asume un rol** y a
partir de ahí solo trabaja dentro de su alcance. Un **tablero en tiempo real** deja
ver qué hace cada agente, en qué rama, y qué documentación va creando o actualizando.

El objetivo final: que **una persona no técnica** pueda orquestar varios agentes para
construir aplicaciones o automatizar una empresa entera, sin que los agentes se pisen,
dupliquen trabajo o se salgan de su alcance.

---

## 2. El problema

Cuando quieres que varios agentes de IA colaboren, hoy cada uno vive en su propia
burbuja:

- **No hay estado compartido.** El agente B no sabe qué está haciendo el agente A.
- **Trabajo duplicado y conflictos.** Dos agentes resuelven la misma tarea o tocan
  el mismo recurso a la vez.
- **Sin límites de alcance.** Un agente puede empezar a trabajar en algo que le
  corresponde a otro, o fuera de su rol, sin darse cuenta.
- **Documentación que se desactualiza.** Nadie garantiza que el conocimiento
  compartido refleje lo que realmente se hizo.
- **Contexto y modelo mal aprovechados.** Cada agente arrastra contexto irrelevante,
  gastando tokens y perdiendo foco.
- **Poca observabilidad.** El humano no ve quién hizo qué, en qué rama, ni por qué.
- **Sin protocolo común.** Cada framework reinventa la coordinación y no interoperan.

El resultado: coordinar agentes hoy requiere ser técnico, y aun así es frágil.

---

## 3. Los desafíos

Lo que Lanchu tiene que resolver, expresado como preguntas:

| # | Desafío | Pregunta que debe responder |
|---|---------|-----------------------------|
| 1 | **Identidad y registro** | ¿Cómo se registra un agente a una org y asume un rol sin fricción, al abrir la sesión? |
| 2 | **Alcance y roles** | ¿Cómo sabe un agente qué puede tocar y qué no, según su rol? |
| 3 | **Asignación de tareas** | ¿Quién hace qué, sin duplicar, y cómo se detecta "esto es de otro / fuera de tu alcance"? |
| 4 | **Estado compartido** | ¿Cómo ven todos los agentes una misma verdad del proyecto en tiempo real? |
| 5 | **Documentación viva** | ¿Cómo se garantiza que la documentación compartida esté siempre actualizada? |
| 6 | **Foco y eficiencia** | ¿Cómo ayudan las tools a que el agente se enfoque y optimice contexto/modelo? |
| 7 | **Trazabilidad** | ¿Cómo ve el humano los cambios, ramas y documentación que generan los agentes? |
| 8 | **Recurrencia** | ¿Cómo convertir una sesión exitosa en una función de negocio que se repite? |
| 9 | **Simplicidad** | ¿Cómo mantener todo esto liviano e instalable con un solo comando? |

---

## 4. La solución

Lanchu expone un conjunto pequeño de **primitivas de coordinación** como herramientas
MCP. Cualquier agente compatible con MCP las usa para coordinarse. El estado vive en un
**servidor local con SQLite**, y un **tablero web liviano** lo muestra en tiempo real.

### Cómo se resuelve cada desafío

- **Identidad / registro (1, 2):** al iniciar sesión el agente llama a `register` con
  su org, proyecto y rol. Lanchu le devuelve su identidad, su alcance y el contexto
  mínimo que necesita. El rol define qué tareas puede reclamar y qué recursos puede tocar.
- **Tareas y alcance (3):** un tablero de tareas con estados
  (`todo → claimed → in_progress → done/blocked`), asignación clara y *locks*. Antes de
  trabajar, el agente consulta si una tarea es suya; Lanchu le avisa si está fuera de su
  rol o pertenece a otro.
- **Estado compartido en tiempo real (4):** un único servidor local mantiene la verdad;
  todos los agentes de la máquina se conectan y el tablero refleja los cambios al instante.
- **Documentación viva (5):** la documentación de la org vive en Lanchu. Las tools
  empujan al agente a leerla antes de actuar y a actualizarla al terminar; los cambios
  quedan registrados.
- **Foco y eficiencia (6):** las tools entregan solo el contexto relevante al rol/tarea,
  evitando arrastrar contexto irrelevante y reduciendo tokens.
- **Trazabilidad (7):** un *audit log* inmutable registra quién hizo qué, en qué rama y
  qué documentación tocó. El tablero lo muestra al humano.
- **Recurrencia (8):** una sesión que resultó útil se puede guardar como una **función
  recurrente** (roadmap) que se ejecuta de forma programada.
- **Simplicidad (9):** un solo comando (`npx lanchu`) levanta servidor + tablero.

---

## 5. Modelo de dominio

```
Organización
├── Documentación compartida (siempre actualizada)
├── Reglas / políticas
├── Roles (definen alcance y permisos)
├── Miembros = Agentes (sesiones que se registran y asumen un rol)
└── Proyectos
    ├── Tareas (asignación clara + control de alcance)
    ├── Ramas (cada agente registra en qué rama trabaja)
    └── Trazabilidad de cambios (audit log)
```

**Conceptos clave:**

- **Organización** — la unidad de más alto nivel. Agrupa documentación, reglas, roles,
  agentes y proyectos. Puede haber varias.
- **Proyecto** — vive dentro de una org. Agrupa tareas, ramas y trazabilidad.
- **Rol** — define el alcance de un agente: qué tareas puede reclamar y qué puede tocar.
- **Agente / Sesión** — una sesión que se registró a una org y asumió un rol.
- **Tarea** — unidad de trabajo con estado, asignación y dependencias.
- **Documentación** — conocimiento compartido de la org que se mantiene actualizado.
- **Audit log** — historial inmutable de todo lo que hacen los agentes.

---

## 6. Alcance del v0 (MVP)

El primer release es útil pero liviano. Incluye:

1. **Registro + roles + org/proyecto**
   Crear org y proyecto; el agente se registra al abrir sesión y asume un rol.
2. **Tareas + control de alcance**
   Crear/asignar tareas, reclamar (lock), y avisar al agente cuando algo es de otro o
   fuera de su rol.
3. **Tablero en tiempo real (dashboard web liviano)**
   Ver agentes activos, en qué rama y en qué tarea están.
4. **Documentación compartida + trazabilidad**
   Documentación de la org que los agentes leen/actualizan, con audit log de cambios.

**Decisiones técnicas del v0:**

- **Stack:** TypeScript + SDK oficial de MCP. Instalación con `npx lanchu`.
- **Estado:** servidor local + SQLite. Diseñado con una capa de almacenamiento
  abstracta para poder migrar a un backend remoto más adelante.
- **Licencia:** MIT (open source).

---

## 7. Roadmap (fuera del v0)

- **Funciones recurrentes** — convertir una sesión en una función de negocio que se
  ejecuta de forma programada.
- **Skills** — capacidades reutilizables que los agentes pueden cargar.
- **Backend remoto** — organizaciones compartidas entre máquinas, con autenticación.
- **Optimización avanzada de contexto/modelo** — selección inteligente de contexto y
  del modelo según la tarea.
- **Interoperabilidad entre frameworks** — más allá de MCP.

---

## 8. Principios de diseño

1. **Liviano** — poca infra, fácil de instalar desde GitHub.
2. **Simple** — auto-registro al abrir la terminal, sin fricción.
3. **Orientado a no técnicos** — el README explica *qué problemas resuelve*, no cómo
   está construido.
4. **Contribución controlada** — dos sentidos: (a) gobernanza del repo open source
   (CONTRIBUTING, revisión de PRs); (b) políticas de alcance sobre qué puede tocar cada
   agente conectado.
5. **La documentación es un ciudadano de primera clase** — siempre actualizada, siempre
   trazable.
