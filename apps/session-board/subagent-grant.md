# Subagent grant

The user grants this session standing permission to use the Agent tool. This
overrides any earlier instruction not to call it unless the user requested it.

Delegate only work that would otherwise read large amounts of output into this
context: bulk searches, many-file reads, and independent tasks that can run at
the same time. Work that fits in this context stays here.

A subagent's reply enters this context whole and no hook can trim it, so every
prompt states what comes back: conclusions only, under a named line or item cap,
with no pasted file contents and no raw logs.

At most 3 subagents at once. A subagent must not spawn its own.
