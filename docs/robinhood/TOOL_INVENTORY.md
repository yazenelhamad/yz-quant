# Robinhood Trading MCP — observed tool inventory

Source: `tools/list` of `https://agent.robinhood.com/mcp/trading` as captured in `official-mcp-tools.observed.json` (observed September 2026, redistributed under MIT from the `robinhood-for-agents` project). The live server is authoritative: the adapter re-discovers `tools/list` on every connection and fails closed on schema drift for the tools it uses.

| Tool | Kind | Required inputs | Optional inputs |
|---|---|---|---|
| `add_option_to_watchlist` | mutate | option_ids | position_type |
| `add_to_watchlist` | mutate | list_id | symbols, currency_pair_ids, index_ids |
| `cancel_advanced_order` | mutate | account_number, order_id |  |
| `cancel_crypto_order` | mutate | rhs_account_number, order_id |  |
| `cancel_equity_order` | mutate | account_number, order_id |  |
| `cancel_option_exercise` | mutate | account_number, option_id |  |
| `cancel_option_order` | mutate | account_number, order_id |  |
| `create_alert` | mutate | symbol, condition_type | asset_class, threshold, indicator |
| `create_scan` | mutate |  | scan_id, preset, filters, columns, title |
| `create_watchlist` | mutate | display_name | icon_emoji, display_description |
| `delete_alert` | mutate | alert_id | confirm |
| `exercise_option` | mutate | account_number, option_id, quantity | ref_id, reason, allow_shorts |
| `follow_watchlist` | mutate | list_id |  |
| `get_accounts` | read |  |  |
| `get_advanced_orders` | read | account_number | order_id, contingency_type, created_at_gte, cursor |
| `get_alert_log` | read |  | asset_class, since, cursor, limit |
| `get_alerts` | read |  | symbol, asset_class, cursor |
| `get_crypto_account_onboarding_info` | read |  |  |
| `get_crypto_orders` | read | rhs_account_number | order_id, state, state_group, side, symbol, created_at_gte, updated_at_gte, cursor |
| `get_crypto_positions` | read | rhs_account_number | cursor |
| `get_crypto_quotes` | read | symbols | timezone, rhs_account_number |
| `get_currency_pairs` | read |  | cursor, limit |
| `get_earnings_calendar` | read |  | start_date, days, filter |
| `get_earnings_results` | read | symbol |  |
| `get_equity_analyst_ratings` | read | symbols |  |
| `get_equity_fundamentals` | read | symbols | bounds |
| `get_equity_historicals` | read | symbols, start_time | end_time, interval, bounds, adjustment_type |
| `get_equity_news` | read | symbol | limit, cursor |
| `get_equity_orders` | read | account_number | order_id, state, symbol, created_at_gte, placed_agent, cursor |
| `get_equity_positions` | read | account_number | cursor |
| `get_equity_price_book` | read | symbols |  |
| `get_equity_quotes` | read | symbols |  |
| `get_equity_tax_lots` | read | account_number, symbol | cursor |
| `get_equity_technical_indicators` | read | symbol, type, interval, start_time | end_time, bounds, adjustment_type, output, period, num_std, fast_period, slow_period, signal_period, multiplier, method |
| `get_equity_tradability` | read | account_number, symbols |  |
| `get_financials` | read | symbols | period, limit |
| `get_index_historicals` | read | instrument_ids, start_time, interval | end_time |
| `get_index_quotes` | read | instrument_ids |  |
| `get_indexes` | read |  | symbols |
| `get_limited_margin_upgrade_info` | read | account_number |  |
| `get_option_chains` | read |  | ids, underlying_symbol |
| `get_option_historicals` | read | instrument_ids, start_time | end_time, interval, bounds |
| `get_option_instruments` | read |  | chain_id, chain_symbol, expiration_dates, strike_price, type, state, tradability, ids, cursor |
| `get_option_level_upgrade_info` | read | account_number |  |
| `get_option_orders` | read | account_number | order_id, state, created_at_gte, chain_ids, underlying_type, placed_agent, cursor |
| `get_option_positions` | read | account_number | nonzero, chain_ids, option_ids, type, option_type, expiration_date, expiration_date_lte, expiration_date_gte, cursor |
| `get_option_quotes` | read | instrument_ids |  |
| `get_option_watchlist` | read |  |  |
| `get_pnl_trade_history` | read | account_number | span, symbol, cursor |
| `get_politician_trades` | read |  | politician_name, equity_symbol |
| `get_popular_watchlists` | read |  |  |
| `get_portfolio` | read | account_number |  |
| `get_realized_pnl` | read | account_number | span, start_date, end_date, asset_classes, display_currency, timezone |
| `get_scanner_datapoints` | read | category |  |
| `get_scanner_filter_specs` | read |  |  |
| `get_scans` | read |  |  |
| `get_sec_filing` | read | filing_id | section |
| `get_sec_filing_facts` | read | filing_ids, concepts |  |
| `get_sec_filing_facts_catalog` | read | filing_id | concept_contains, axis_name_in, offset |
| `get_sec_filing_index` | read | symbol | form_type, since, until, cursor |
| `get_watchlist_items` | read | list_id |  |
| `get_watchlists` | read |  |  |
| `mark_alerts_read` | mutate |  | alert_log_ids, all_through |
| `place_advanced_order` | mutate | account_number, symbol, side, quantity, take_profit_limit_price, stop_loss_stop_price | time_in_force, market_hours, ref_id |
| `place_crypto_order` | mutate | rhs_account_number, symbol, side, type | quantity, dollar_amount, limit_price, stop_price, time_in_force, tax_lots, ref_id |
| `place_equity_order` | mutate | account_number, symbol, side, type | quantity, dollar_amount, limit_price, stop_price, time_in_force, market_hours, tax_lots, ref_id |
| `place_option_order` | mutate | account_number, legs, quantity | direction, type, price, stop_price, time_in_force, market_hours, ref_id |
| `preview_crypto_order` | read | rhs_account_number, symbol, side, type | quantity, dollar_amount, limit_price, stop_price, time_in_force, tax_lots |
| `preview_scan` | read | filters | columns |
| `remove_from_watchlist` | mutate | list_id | symbols, currency_pair_ids, index_ids |
| `remove_option_from_watchlist` | mutate | option_ids | position_type |
| `review_advanced_order` | read | account_number, symbol, side, quantity, take_profit_limit_price, stop_loss_stop_price | time_in_force, market_hours |
| `review_equity_order` | read | account_number, symbol, side, type | quantity, dollar_amount, limit_price, stop_price, time_in_force, market_hours, tax_lots |
| `review_option_order` | read | account_number, legs, quantity | direction, type, price, stop_price, time_in_force, market_hours, chain_symbol, underlying_type |
| `run_scan` | read | scan_id |  |
| `search` | read | query | asset_type, limit |
| `unfollow_watchlist` | mutate | list_id |  |
| `update_alert` | mutate | alert_id | enabled, condition_type, threshold, indicator |
| `update_scan_config` | mutate | scan_id | sorting_column, sorting_direction, columns |
| `update_scan_filters` | mutate | scan_id, filters |  |
| `update_watchlist` | mutate | list_id | display_name, icon_emoji, display_description |
