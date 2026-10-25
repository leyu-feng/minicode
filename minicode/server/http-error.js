export async function httpErrorDetails(response, secrets = []) {
  return (await httpErrorInfo(response, secrets)).detail
}

export async function httpErrorInfo(response, secrets = []) {
  let detail
  let code
  try {
    const body = await response.text()
    try {
      const data = JSON.parse(body)
      const error = data?.error
      const errorCode = error?.code ?? data?.code
      if (typeof errorCode === "string") code = errorCode
      detail = [
        typeof error === "string" ? error : error?.message,
        error?.code ?? data?.code,
        error?.type,
        error?.param,
        data?.error_description,
        data?.message,
        ...(Array.isArray(data?.errors) ? data.errors.flatMap(item =>
          typeof item === "string" ? [item] : [item?.message, item?.code, item?.field])
          : [data?.errors]),
      ].filter(value => typeof value === "string" && value.trim()).join("; ")
    } catch {
      detail = body
    }
    detail ||= "Provider returned no error details."
  } catch (error) {
    detail = `Could not read provider error response: ${error.message}`
  }
  const requestIds = ["x-github-request-id", "x-request-id", "apim-request-id", "request-id", "x-ms-request-id"]
    .map(name => {
      const value = response.headers.get(name)
      return value ? `${name}: ${value}` : ""
    }).filter(Boolean)
  return { detail: redactSecrets([detail, ...requestIds].join("\n"), secrets).slice(0, 4000), code }
}

export function redactSecrets(value, secrets = []) {
  let result = value
  for (const secret of secrets) {
    if (typeof secret !== "string" || !secret) continue
    result = result.replaceAll(secret, "[redacted]").replaceAll(JSON.stringify(secret).slice(1, -1), "[redacted]")
  }
  return result.replace(/Bearer\s+[^\s",;]+/gi, "Bearer [redacted]")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
}
