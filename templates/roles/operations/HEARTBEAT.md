# Heartbeat Tasks

## Process inbox

Check for NEW messages, requests, and action items since the last heartbeat. If inbox is empty or already processed, skip. Triage and respond or delegate only new items.

## System health check

Verify that key operational tools and services are functioning correctly. Compare with last heartbeat — only report NEW issues or status changes. If everything was healthy last time and nothing changed, skip.

## Generate daily summary

Compile a summary of completed tasks, pending items, and blockers — but ONLY once per day (not every heartbeat). Check `memory_search` for today's date to see if a summary was already generated. If yes, skip.
