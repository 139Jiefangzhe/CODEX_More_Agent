ALTER TABLE `wc_pool_event_log`
  MODIFY COLUMN `processed_status` enum('pending','applied','duplicate','orphan_exit','overflow_entry','reconciled_late_pair','failed','skipped') NOT NULL DEFAULT 'pending';

ALTER TABLE `wc_pool_event_log`
  DROP INDEX `uniq_park_source_event`;

ALTER TABLE `wc_pool_event_log`
  ADD INDEX `idx_park_source_event` (`park_id`,`source_event_id`);
