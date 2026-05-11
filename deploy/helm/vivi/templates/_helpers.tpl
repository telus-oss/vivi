{{/*
Tenant identifier — defaults to the release name when user.name is blank.
Used in labels so cluster-wide queries (`kubectl get pods -A -l vivi.tenant=alice`)
work consistently.
*/}}
{{- define "vivi.tenant" -}}
{{- default .Release.Name .Values.user.name | lower }}
{{- end -}}

{{/*
Common labels applied to every templated resource.
*/}}
{{- define "vivi.labels" -}}
app.kubernetes.io/name: vivi
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
vivi.tenant: {{ include "vivi.tenant" . }}
{{- end -}}

{{/*
Selector labels for matching pods/services/etc by app.
Use the explicit `app:` value (matches what server/k8s.ts already creates).
*/}}
{{- define "vivi.proxy.selectorLabels" -}}
app: proxy
{{- end -}}

{{- define "vivi.viviServer.selectorLabels" -}}
app: vivi-server
{{- end -}}

{{/*
Image reference helpers — default tag to chart appVersion when blank.
*/}}
{{- define "vivi.proxy.image" -}}
{{ .Values.proxy.image.repository }}:{{ .Values.proxy.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{- define "vivi.viviServer.image" -}}
{{ .Values.viviServer.image.repository }}:{{ .Values.viviServer.image.tag | default .Chart.AppVersion }}
{{- end -}}
