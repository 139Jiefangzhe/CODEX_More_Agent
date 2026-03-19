SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS `wc_pool_state` (
  `park_id` varchar(32) NOT NULL,
  `report_capacity` int NOT NULL,
  `physical_capacity` int NOT NULL,
  `hidden_capacity` int NOT NULL,
  `report_inside` int NOT NULL DEFAULT 0,
  `hidden_inside` int NOT NULL DEFAULT 0,
  `version` bigint NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`park_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Logical pool realtime state';

CREATE TABLE IF NOT EXISTS `wc_pool_allocation` (
  `allocation_id` bigint NOT NULL AUTO_INCREMENT,
  `park_id` varchar(32) NOT NULL,
  `session_id` varchar(128) NOT NULL,
  `plate` varchar(16) DEFAULT NULL,
  `pool_type` enum('report','hidden') NOT NULL,
  `vehicle_group` varchar(32) NOT NULL DEFAULT 'report-first',
  `enter_event_id` varchar(64) NOT NULL,
  `exit_event_id` varchar(64) DEFAULT NULL,
  `enter_time` datetime NOT NULL,
  `exit_time` datetime DEFAULT NULL,
  `status` enum('inside','out') NOT NULL DEFAULT 'inside',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`allocation_id`),
  UNIQUE KEY `uniq_park_enter_event` (`park_id`,`enter_event_id`),
  KEY `idx_park_session_status` (`park_id`,`session_id`,`status`,`enter_time`),
  KEY `idx_park_status_pool` (`park_id`,`status`,`pool_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Logical pool allocation ledger';

CREATE TABLE IF NOT EXISTS `wc_pool_event_log` (
  `event_id` varchar(64) NOT NULL,
  `park_id` varchar(32) NOT NULL,
  `source_event_id` varchar(64) NOT NULL,
  `session_id` varchar(128) NOT NULL,
  `event_type` enum('00','01') NOT NULL,
  `event_time` datetime NOT NULL,
  `plate` varchar(16) DEFAULT NULL,
  `auth_type` varchar(64) DEFAULT NULL,
  `vehicle_group` varchar(32) NOT NULL DEFAULT 'report-first',
  `assigned_pool` enum('report','hidden') DEFAULT NULL,
  `processed_status` enum('pending','applied','duplicate','orphan_exit','overflow_entry','reconciled_late_pair','failed','skipped') NOT NULL DEFAULT 'pending',
  `error_message` varchar(255) DEFAULT NULL,
  `raw_payload` json DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`event_id`),
  KEY `idx_park_source_event` (`park_id`,`source_event_id`),
  KEY `idx_park_event_time` (`park_id`,`event_time`),
  KEY `idx_park_processed_status` (`park_id`,`processed_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Logical pool event audit log';

CREATE TABLE IF NOT EXISTS `wc_pool_daily_counter` (
  `park_id` varchar(32) NOT NULL,
  `counter_day` varchar(8) NOT NULL,
  `report_in` bigint NOT NULL DEFAULT 0,
  `report_out` bigint NOT NULL DEFAULT 0,
  `last_event_time` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`park_id`,`counter_day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Daily report counters';

CREATE TABLE IF NOT EXISTS `wc_pool_push_log` (
  `push_id` bigint NOT NULL AUTO_INCREMENT,
  `park_id` varchar(32) NOT NULL,
  `dotime` bigint NOT NULL,
  `payload` json NOT NULL,
  `request_url` varchar(512) DEFAULT NULL,
  `status_code` int DEFAULT NULL,
  `response_body` json DEFAULT NULL,
  `success` tinyint(1) NOT NULL DEFAULT 0,
  `retry_count` int NOT NULL DEFAULT 0,
  `error_message` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`push_id`),
  KEY `idx_park_dotime` (`park_id`,`dotime`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Operations push audit log';

CREATE TABLE IF NOT EXISTS `wc_pool_checkpoint` (
  `park_id` varchar(32) NOT NULL,
  `last_event_time` datetime NOT NULL DEFAULT '1970-01-01 00:00:00',
  `last_event_id` varchar(64) NOT NULL DEFAULT '',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`park_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Source event checkpoint';

SET FOREIGN_KEY_CHECKS = 1;

