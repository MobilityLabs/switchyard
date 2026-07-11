CREATE INDEX `agent_sessions_issue_id_idx` ON `agent_sessions` (`issue_id`);--> statement-breakpoint
CREATE INDEX `events_issue_id_idx` ON `events` (`issue_id`);--> statement-breakpoint
CREATE INDEX `issues_project_id_idx` ON `issues` (`project_id`);--> statement-breakpoint
CREATE INDEX `issues_status_idx` ON `issues` (`status`);--> statement-breakpoint
CREATE INDEX `issues_assignee_id_idx` ON `issues` (`assignee_id`);