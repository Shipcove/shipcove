{{/* Nom complet de la release (préfixe des objets). */}}
{{- define "shipcove.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "shipcove.labels" -}}
app.kubernetes.io/name: shipcove
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Sélecteur d'un composant : (dict "ctx" $ "component" "api") */}}
{{- define "shipcove.selector" -}}
app.kubernetes.io/name: shipcove
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "shipcove.image" -}}
{{- printf "%sshipcove-%s:%s" .ctx.Values.image.registry .name (.ctx.Values.image.tag | default .ctx.Chart.AppVersion) -}}
{{- end -}}

{{- define "shipcove.sandboxImage" -}}
{{- .Values.sandbox.image | default (include "shipcove.image" (dict "ctx" . "name" "sandbox")) -}}
{{- end -}}

{{- define "shipcove.appHost" -}}
{{- .Values.ingress.host | default (urlParse .Values.publicUrl).host -}}
{{- end -}}

{{/* URL interne de la gateway (vue des sandboxes : FQDN, elles sont dans un autre namespace). */}}
{{- define "shipcove.gatewayHost" -}}
{{- printf "%s-gateway.%s.svc.cluster.local" (include "shipcove.fullname" .) .Release.Namespace -}}
{{- end -}}

{{/* Variables communes aux services Node.js : (dict "ctx" $ "component" "api" "db" "api") */}}
{{- define "shipcove.commonEnv" -}}
{{- $v := .ctx.Values -}}
- name: NODE_ENV
  value: {{ $v.nodeEnv | quote }}
- name: LOG_FORMAT
  value: json
- name: LOG_LEVEL
  value: {{ $v.logLevel | quote }}
- name: INSTANCE_ID
  valueFrom: { fieldRef: { fieldPath: metadata.name } }
- name: DATABASE_URL
  valueFrom:
    secretKeyRef: { name: {{ $v.database.existingSecret }}, key: {{ .db }} }
- name: DATABASE_POOL_MAX
  value: {{ $v.database.poolMax | quote }}
- name: VAULT_ADDR
  value: {{ $v.vault.address | quote }}
- name: VAULT_KV_MOUNT
  value: {{ $v.vault.kvMount | quote }}
{{- with $v.vault.namespace }}
- name: VAULT_NAMESPACE
  value: {{ . | quote }}
{{- end }}
- name: VAULT_AUTH_METHOD
  value: {{ $v.vault.authMethod | quote }}
{{- if eq $v.vault.authMethod "kubernetes" }}
- name: VAULT_K8S_ROLE
  value: {{ index $v.vault.kubernetes.roles .component | quote }}
{{- else }}
- name: VAULT_ROLE_ID_FILE
  value: /var/run/secrets/shipcove/approle/role-id
- name: VAULT_SECRET_ID_FILE
  value: /var/run/secrets/shipcove/approle/secret-id
{{- end }}
- name: S3_ENDPOINT
  value: {{ $v.s3.endpoint | quote }}
- name: S3_REGION
  value: {{ $v.s3.region | quote }}
- name: S3_BUCKET
  value: {{ $v.s3.bucket | quote }}
- name: S3_ATTACHMENTS_BUCKET
  value: {{ $v.s3.attachmentsBucket | quote }}
- name: S3_FORCE_PATH_STYLE
  value: {{ $v.s3.forcePathStyle | quote }}
- name: LITELLM_URL
  value: {{ $v.litellm.url | quote }}
- name: PUBLIC_URL
  value: {{ $v.publicUrl | quote }}
- name: PREVIEW_DOMAIN
  value: {{ $v.preview.domain | quote }}
- name: PREVIEW_PUBLIC_SCHEME
  value: {{ $v.preview.scheme | quote }}
{{- with $v.preview.publicPort }}
- name: PREVIEW_PUBLIC_PORT
  value: {{ . | quote }}
{{- end }}
{{- end -}}

{{/* Volumes communes : /tmp inscriptible et, en AppRole, l'identité Vault du composant. */}}
{{- define "shipcove.commonVolumes" -}}
- name: tmp
  emptyDir: { sizeLimit: {{ .tmp | default "1Gi" }} }
{{- if ne .ctx.Values.vault.authMethod "kubernetes" }}
- name: approle
  secret:
    secretName: {{ .ctx.Values.vault.approle.existingSecret }}
    items:
      - { key: {{ printf "%s-role-id" .component }}, path: role-id }
      - { key: {{ printf "%s-secret-id" .component }}, path: secret-id }
{{- end }}
{{- end -}}

{{- define "shipcove.commonMounts" -}}
- { name: tmp, mountPath: /tmp }
{{- if ne .ctx.Values.vault.authMethod "kubernetes" }}
- { name: approle, mountPath: /var/run/secrets/shipcove/approle, readOnly: true }
{{- end }}
{{- end -}}

{{- define "shipcove.podDefaults" -}}
{{- with .Values.image.pullSecrets }}
imagePullSecrets:
  {{- range . }}
  - name: {{ . }}
  {{- end }}
{{- end }}
securityContext: {{ toYaml .Values.podSecurityContext | nindent 2 }}
{{- with .Values.nodeSelector }}
nodeSelector: {{ toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations: {{ toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity: {{ toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* Sonde HTTP : (dict "path" "/health/live" "port" "http") */}}
{{- define "shipcove.probes" -}}
startupProbe:
  httpGet: { path: {{ .path }}, port: {{ .port }} }
  periodSeconds: 3
  failureThreshold: 60
livenessProbe:
  httpGet: { path: {{ .path }}, port: {{ .port }} }
  periodSeconds: 15
  timeoutSeconds: 3
  failureThreshold: 4
readinessProbe:
  httpGet: { path: {{ .path }}, port: {{ .port }} }
  periodSeconds: 5
  timeoutSeconds: 3
{{- end -}}
