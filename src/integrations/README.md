# Delivery integrations

`DeliveryProvider` is intentionally an interface only. When Rappidex credentials and its API contract are available, add a provider implementation here and invoke it after an authorized order transitions to `OUT_FOR_DELIVERY`. Do not call external delivery APIs from public checkout endpoints.
