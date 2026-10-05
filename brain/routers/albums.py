"""Album catalog endpoints: full DTO list, detail envelope, whole-release editing."""
from typing import Literal, Optional, Union, Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, model_validator

from auth import get_current_user
from config import get_base_url
from services import album_service

router = APIRouter(prefix="/api/albums", tags=["albums"])


class AlbumEditPayload(BaseModel):
    model_config = ConfigDict(extra='forbid')

    title: Optional[str] = None
    album_artist: Optional[str] = None
    year: Optional[Union[str, int]] = None

    cover_action: Literal["keep", "replace", "remove"] = "keep"
    cover_base64: Optional[str] = None
    cover_url: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def auto_infer_cover_action(cls, data: Any) -> Any:
        if isinstance(data, dict):
            has_cover = bool(data.get("cover_base64") or data.get("cover_url"))
            if has_cover and data.get("cover_action") in (None, "keep"):
                data["cover_action"] = "replace"
        return data

    @model_validator(mode="after")
    def validate_cover_semantics(self):
        if self.cover_action in ("keep", "remove"):
            if self.cover_base64 is not None or self.cover_url is not None:
                raise ValueError(f"cover_base64 and cover_url must be null when cover_action is '{self.cover_action}'")
        elif self.cover_action == "replace":
            if not self.cover_base64 and not self.cover_url:
                raise ValueError("Either cover_base64 or cover_url must be provided when cover_action is 'replace'")
            if self.cover_base64 and self.cover_url:
                raise ValueError("Provide either cover_base64 or cover_url, not both")
        return self


@router.get("")
def get_all_albums(request: Request, current_user: dict = Depends(get_current_user)):
    """Каталог альбомов: полный DTO одним запросом (artist, year, track_count, cover)."""
    base_url = get_base_url(request)
    return album_service.get_albums_catalog(base_url)


@router.get("/{album_id}")
def get_album_detail(album_id: int, request: Request, current_user: dict = Depends(get_current_user)):
    """Detail-конверт {"album": AlbumDTO, "tracks": TrackDTO[]}; 404 для несуществующего альбома."""
    base_url = get_base_url(request)
    return album_service.get_album_detail(album_id, current_user, base_url)


@router.patch("/{album_id}")
def update_album(album_id: int, payload: AlbumEditPayload, request: Request, current_user: dict = Depends(get_current_user)):
    """Редактирование релиза: title/album_artist/year пишутся в теги всех треков.

    При конфликте идентичности (title + album_artist уже существует) альбом
    сливается с существующей записью. Ответ status="partial" содержит список
    треков, чьи файлы обновить не удалось.
    """
    base_url = get_base_url(request)
    return album_service.update_album(album_id, payload, current_user, base_url)
