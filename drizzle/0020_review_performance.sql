CREATE INDEX `dependencies_blocked_id_idx` ON `dependencies` (`blocked_id`);--> statement-breakpoint
CREATE INDEX `events_type_issue_id_idx` ON `events` (`type`,`issue_id`);--> statement-breakpoint
CREATE INDEX `issues_parent_id_idx` ON `issues` (`parent_id`);--> statement-breakpoint
CREATE INDEX `issues_project_status_idx` ON `issues` (`project_id`,`status`);