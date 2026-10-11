"""Raw XLSX transport for the bounded add-only catalog import."""

from __future__ import annotations

from anyio import to_thread
from fastapi import APIRouter, Header, HTTPException, Request, Response

from naryadai.application.catalog_import import (
    MAX_BYTES,
    MIME,
    CatalogImportPreview,
    ParsedCatalog,
    apply_import,
    parse_workbook,
    preview_import,
    template_bytes,
)
from naryadai.application.common import OperationError
from naryadai.auth.dependencies import DatabaseDep, PrincipalDep, require_admin

router = APIRouter(prefix="/catalog", tags=["catalog"])


async def _body(request: Request, principal: PrincipalDep) -> bytes:
    require_admin(principal)
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != MIME:
        raise HTTPException(status_code=415, detail="xlsx_content_type_required")
    try:
        if int(request.headers.get("content-length", "0")) > MAX_BYTES:
            raise HTTPException(status_code=413, detail="import_file_too_large")
    except ValueError:
        raise HTTPException(status_code=422, detail="invalid_content_length") from None
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > MAX_BYTES:
            raise HTTPException(status_code=413, detail="import_file_too_large")
        data.extend(chunk)
    return bytes(data)


async def _parsed(request: Request, principal: PrincipalDep) -> ParsedCatalog:
    content = await _body(request, principal)
    limiter = getattr(request.app.state, "catalog_import_limiter", None)
    return await to_thread.run_sync(parse_workbook, content, limiter=limiter)


@router.get("/import-template.xlsx")
async def import_template(
    request: Request, principal: PrincipalDep, database: DatabaseDep
) -> Response:
    content = await template_bytes(database, principal, request.app.state.catalog_import_limiter)
    return Response(
        content=content,
        media_type=MIME,
        headers={"Content-Disposition": 'attachment; filename="catalog-import-template.xlsx"'},
    )


@router.post("/import/preview", response_model=CatalogImportPreview)
async def preview_catalog_import(
    request: Request, principal: PrincipalDep, database: DatabaseDep
) -> CatalogImportPreview:
    try:
        return await preview_import(database, principal, await _parsed(request, principal))
    except OperationError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from None


@router.post("/import/apply", response_model=CatalogImportPreview)
async def apply_catalog_import(
    request: Request,
    principal: PrincipalDep,
    database: DatabaseDep,
    fingerprint: str = Header(alias="X-Import-Fingerprint", min_length=64, max_length=64),
) -> CatalogImportPreview:
    try:
        return await apply_import(
            database, principal, await _parsed(request, principal), fingerprint
        )
    except OperationError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from None
